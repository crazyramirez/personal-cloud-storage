/**
 * StorageGuardian — guardián obligatorio de toda mutación sobre el HDD (spec §3.4).
 *
 * Principio: FALLA EN CERRADO. El estado READY solo se alcanza demostrando positivamente
 * cada condición; cualquier duda, excepción o dato inesperado produce un estado que
 * bloquea mutaciones. Este módulo nunca escribe en disco.
 *
 * Secuencia de comprobación (la primera que falla determina el estado):
 *   1. UUID configurado                              → NEEDS_CHECK  NOT_CONFIGURED
 *   2. /proc/self/mountinfo legible y bien formado   → UNAVAILABLE  MOUNTINFO_UNREADABLE
 *   3. Directorio de montaje existe y es canónico    → UNAVAILABLE  NOT_MOUNTED / NEEDS_CHECK MOUNTPOINT_INVALID
 *   4. Hay un montaje visible en él (no ambiguo)     → UNAVAILABLE  NOT_MOUNTED / MOUNT_AMBIGUOUS
 *   5. No es el FS del sistema (microSD)             → UNAVAILABLE  NOT_MOUNTED
 *   6. stat(mountpoint).dev coincide con mountinfo   → UNAVAILABLE  MOUNT_CHANGED
 *   7. El dispositivo con el UUID esperado existe    → UNAVAILABLE  DEVICE_ABSENT / WRONG_VOLUME SOURCE_MISMATCH
 *   8. Y es el que está montado                      → WRONG_VOLUME SOURCE_MISMATCH
 *   9. Montaje del FS completo, tipo esperado, sin `force`
 *  10. `.pcloud/` y marcador válidos y coincidentes  → NEEDS_CHECK / WRONG_VOLUME MARKER_MISMATCH
 *  11. Raíz de datos válida en el mismo dispositivo  → NEEDS_CHECK  DATA_ROOT_INVALID
 *  12. Montaje rw y kernel permite escribir          → READ_ONLY / NEEDS_CHECK PERMISSION_DENIED
 *  → READY
 */

import { posix as path } from 'node:path';
import {
  volumeAllowsMutations,
  volumeAllowsReads,
  type VolumeIssue,
  type VolumeIssueCode,
  type VolumeMountInfo,
  type VolumeState,
  type VolumeStatus,
} from '@pcloud/contracts';
import { formatDevice, sameDevice } from './device-number.ts';
import { findTopMount, hasMountOption, parseMountInfo, type MountInfoEntry } from './mountinfo.ts';
import type { StorageProbe } from './probe.ts';
import { parseVolumeMarker, VOLUME_MARKER_MAX_BYTES } from './volume-marker.ts';

export const INTERNAL_DIR_NAME = '.pcloud';
export const MARKER_FILE_NAME = 'volume-id';
const BY_UUID_DIR = '/dev/disk/by-uuid';

export type ConfiguredFsType = 'exfat' | 'ntfs3' | 'ntfs-3g';

/** Tipo que aparece en mountinfo para cada controlador configurado. */
const MOUNTINFO_FSTYPES: Readonly<Record<ConfiguredFsType, readonly string[]>> = {
  exfat: ['exfat'],
  ntfs3: ['ntfs3'],
  'ntfs-3g': ['fuseblk'],
};

/** UUID de exFAT/FAT (XXXX-XXXX), NTFS (16 hex) o UUID estándar. Nunca contiene '/'. */
const FS_UUID = /^(?:[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}|[0-9A-Fa-f]{16}|[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})$/;

export function isFsUuid(value: string): boolean {
  return FS_UUID.test(value);
}

export interface StorageGuardianOptions {
  /** Ruta absoluta y canónica, p. ej. /srv/pcloud. */
  readonly mountpoint: string;
  /** UUID del sistema de archivos (lsblk -f). null = instalación aún no configurada. */
  readonly expectedFsUuid: string | null;
  readonly fsType: ConfiguredFsType;
  /** Id de `.pcloud/volume-id`. null = volumen aún no vinculado (onboarding pendiente). */
  readonly volumeMarker: string | null;
  /** Raíz administrada relativa al volumen ("data" por defecto; "." = raíz del volumen). */
  readonly dataRootRelative: string;
  readonly probe: StorageProbe;
  readonly clock?: () => Date;
  /**
   * Máximo que puede tardar una comprobación. Si se supera, el disco no responde: UNHEALTHY y no
   * se lanzan más sondas mientras la anterior siga atascada (no se agota el pool de hilos).
   */
  readonly probeTimeoutMs?: number;
  /** Tiempo con peticiones en curso sin que ninguna se complete para considerar el disco bloqueado. */
  readonly stallMs?: number;
  /** Tras un bloqueo, tiempo sin bloqueos que se exige antes de volver a READY (evita oscilar). */
  readonly recoveryMs?: number;
  /** Reloj monótono en ms (pruebas). */
  readonly monotonic?: () => number;
}

/** Estado interno: añade la identidad del montaje, que no se publica por la API. */
export interface VolumeSnapshot extends VolumeStatus {
  readonly identity: string | null;
}

export function toPublicStatus(snapshot: VolumeSnapshot): VolumeStatus {
  const { identity: _identity, ...status } = snapshot;
  return status;
}

export type LeaseKind = 'read' | 'write' | 'onboarding';

/**
 * Prueba de que el volumen estaba disponible al iniciar una operación.
 * Antes de confirmar (rename final, commit en SQLite) se debe llamar a `revalidate(lease)`.
 */
export interface VolumeLease {
  readonly kind: LeaseKind;
  readonly generation: number;
  readonly mountPoint: string;
  readonly internalDir: string;
  readonly dataRoot: string;
}

export class StorageUnavailableError extends Error {
  override readonly name = 'StorageUnavailableError';
  readonly code = 'STORAGE_UNAVAILABLE';
  readonly httpStatus = 503;
  readonly volumeState: VolumeState;
  readonly issues: readonly VolumeIssue[];
  readonly retryable: boolean;

  constructor(message: string, status: VolumeStatus) {
    super(message);
    this.volumeState = status.state;
    this.issues = status.issues;
    this.retryable = isRetryable(status.state);
  }
}

function isRetryable(state: VolumeState): boolean {
  return state === 'UNAVAILABLE' || state === 'UNHEALTHY' || state === 'INITIALIZING' || state === 'READY';
}

interface Evaluation {
  readonly state: VolumeState;
  readonly issues: readonly VolumeIssue[];
  readonly mount: VolumeMountInfo | null;
  readonly identity: string | null;
}

function issue(code: VolumeIssueCode, message: string, detail?: Record<string, string>): VolumeIssue {
  return detail === undefined ? { code, message } : { code, message, detail };
}

function verdict(
  state: VolumeState,
  cause: VolumeIssue,
  mount: VolumeMountInfo | null = null,
  identity: string | null = null,
): Evaluation {
  return { state, issues: [cause], mount, identity };
}

function errnoOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function describe(error: unknown): string {
  let text = String(error);
  if (error instanceof Error) {
    const prefix = errnoOf(error) ?? error.name;
    text = error.message.startsWith(prefix) ? error.message : `${prefix}: ${error.message}`;
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

const IO_ERRNOS = new Set(['EIO', 'ENXIO', 'ENODEV', 'ESTALE', 'EUCLEAN', 'EBADMSG', 'EREMOTEIO']);

/** Cualquier excepción no prevista se traduce a un estado que bloquea mutaciones. */
function classifyUnexpected(error: unknown): Evaluation {
  const code = errnoOf(error);
  const detail = { error: describe(error) };
  if (code !== undefined && IO_ERRNOS.has(code)) {
    return verdict('UNHEALTHY', issue('IO_ERROR', 'Error de E/S al acceder al volumen', detail));
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return verdict(
      'NEEDS_CHECK',
      issue('PERMISSION_DENIED', 'El servicio no tiene permisos sobre el volumen (revisar uid/gid del montaje)', detail),
    );
  }
  if (code === 'ENOTCONN') {
    return verdict('UNAVAILABLE', issue('NOT_MOUNTED', 'El sistema de archivos FUSE no responde (ENOTCONN)', detail));
  }
  return verdict('UNAVAILABLE', issue('PROBE_FAILED', 'No se pudo determinar el estado del volumen', detail));
}

function toMountView(entry: MountInfoEntry): VolumeMountInfo {
  return {
    mountPoint: entry.mountPoint,
    source: entry.source,
    fsType: entry.fsType,
    readOnly: hasMountOption(entry, 'ro'),
    options: [...new Set([...entry.mountOptions, ...entry.superOptions])],
  };
}

function assertAbsoluteCanonical(value: string, what: string): void {
  if (!path.isAbsolute(value) || path.normalize(value) !== value || value === '/' || value.endsWith('/')) {
    throw new TypeError(`${what} debe ser una ruta absoluta canónica distinta de "/": ${value}`);
  }
}

function assertSafeRelative(value: string, what: string): void {
  const normalized = path.normalize(value);
  const first = normalized.split('/')[0];
  if (
    path.isAbsolute(value) || normalized !== value || value.endsWith('/') ||
    normalized === '..' || normalized.startsWith('../') || first === INTERNAL_DIR_NAME
  ) {
    throw new TypeError(`${what} debe ser relativa, normalizada, sin ".." y fuera de ${INTERNAL_DIR_NAME}: ${value}`);
  }
}

export class StorageGuardian {
  readonly #options: StorageGuardianOptions;
  readonly #probe: StorageProbe;
  readonly #clock: () => Date;
  readonly #internalDir: string;
  readonly #markerPath: string;
  readonly #dataRoot: string;
  readonly #listeners = new Set<(snapshot: VolumeSnapshot) => void>();
  #current: VolumeSnapshot;
  #generation = 0;
  #queued: Promise<VolumeSnapshot> | null = null;
  #tail: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | null = null;
  /** Sonda anterior que no terminó a tiempo; mientras siga pendiente no se lanza otra. */
  #hung: Promise<unknown> | null = null;
  /** Última muestra de actividad del disco: si hay peticiones en curso y nada avanza, se bloqueó. */
  #io: { completed: number; since: number } | null = null;
  /** Último bloqueo observado (reloj monótono): hasta `recoveryMs` después no se vuelve a READY. */
  #lastStallAt: number | null = null;

  constructor(options: StorageGuardianOptions) {
    assertAbsoluteCanonical(options.mountpoint, 'mountpoint');
    assertSafeRelative(options.dataRootRelative, 'dataRootRelative');
    if (options.expectedFsUuid !== null && !isFsUuid(options.expectedFsUuid)) {
      throw new TypeError(`expectedFsUuid con formato no válido: ${options.expectedFsUuid}`);
    }
    this.#options = options;
    this.#probe = options.probe;
    this.#clock = options.clock ?? (() => new Date());
    this.#internalDir = path.join(options.mountpoint, INTERNAL_DIR_NAME);
    this.#markerPath = path.join(this.#internalDir, MARKER_FILE_NAME);
    this.#dataRoot = path.join(options.mountpoint, options.dataRootRelative);
    this.#current = {
      state: 'INITIALIZING',
      issues: [],
      generation: 0,
      checkedAt: this.#clock().toISOString(),
      mount: null,
      identity: null,
    };
  }

  /** Último estado publicado (puede estar desfasado; para decidir, usar check()/acquire()). */
  get current(): VolumeSnapshot {
    return this.#current;
  }

  /**
   * Evalúa el volumen. Garantiza frescura: la evaluación devuelta empezó DESPUÉS de la
   * llamada. Las llamadas concurrentes mientras otra evaluación está en curso comparten
   * la siguiente evaluación (no la actual).
   */
  check(): Promise<VolumeSnapshot> {
    if (this.#queued !== null) return this.#queued;
    const run = this.#tail.then(() => {
      this.#queued = null;
      return this.#evaluateAndPublish();
    });
    this.#queued = run;
    // La cola nunca queda rechazada: un fallo imprevisto se entrega a SU llamante (que falla en
    // cerrado), pero no bloquea las evaluaciones siguientes.
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async acquire(kind: LeaseKind): Promise<VolumeLease> {
    const snapshot = await this.check();
    this.#assertAllowed(kind, snapshot);
    return Object.freeze({
      kind,
      generation: snapshot.generation,
      mountPoint: this.#options.mountpoint,
      internalDir: this.#internalDir,
      dataRoot: this.#dataRoot,
    });
  }

  /** Spec §7.2 paso 2. */
  assertWritableVolume(): Promise<VolumeLease> {
    return this.acquire('write');
  }

  assertReadableVolume(): Promise<VolumeLease> {
    return this.acquire('read');
  }

  /**
   * Revalidación inmediatamente anterior a confirmar (spec §3.4.5). Falla si el volumen
   * dejó de estar disponible o si cambió de generación (desmontaje, remontaje, cambio de
   * estado observado), aunque ahora vuelva a estar READY.
   */
  async revalidate(lease: VolumeLease): Promise<void> {
    const snapshot = await this.check();
    if (snapshot.generation !== lease.generation) {
      throw new StorageUnavailableError(
        `El volumen cambió durante la operación (generación ${lease.generation} → ${snapshot.generation})`,
        snapshot,
      );
    }
    this.#assertAllowed(lease.kind, snapshot);
  }

  onChange(listener: (snapshot: VolumeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Sondeo periódico para detectar desconexiones sin esperar a la siguiente petición. */
  start(intervalMs: number): void {
    if (this.#timer !== null) return;
    const tick = (): void => {
      this.check().catch(() => undefined); // nunca un unhandled rejection desde el sondeo
    };
    tick();
    this.#timer = setInterval(tick, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #assertAllowed(kind: LeaseKind, snapshot: VolumeSnapshot): void {
    if (allows(kind, snapshot)) return;
    const what = kind === 'write' ? 'escritura' : kind === 'read' ? 'lectura' : 'vinculación';
    throw new StorageUnavailableError(
      `El disco configurado no está disponible para ${what} (estado ${snapshot.state})`,
      snapshot,
    );
  }

  async #evaluateAndPublish(): Promise<VolumeSnapshot> {
    const timeoutIssue = (detail: Record<string, string>): Evaluation =>
      verdict('UNHEALTHY', issue('IO_TIMEOUT', 'El disco no responde: se han detenido las operaciones para protegerlo', detail), this.#current.mount, this.#current.identity);
    if (this.#hung !== null) return this.#publish(timeoutIssue({ pending: 'sí' }));

    const limit = this.#options.probeTimeoutMs ?? 8000;
    const running = this.#evaluate().then(
      (evaluation) => evaluation,
      (error: unknown) => classifyUnexpected(error),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), limit);
    });
    const evaluation = await Promise.race([running, timedOut]);
    clearTimeout(timer);
    if (evaluation === null) {
      // La sonda sigue esperando al kernel. Se recuerda para no apilar más y su resultado tardío
      // se descarta (puede estar obsoleto); la siguiente comprobación tras liberarse es la buena.
      const hung = running.finally(() => {
        if (this.#hung === hung) this.#hung = null;
      });
      this.#hung = hung;
      this.#lastStallAt = this.#options.monotonic?.() ?? performance.now();
      return this.#publish(timeoutIssue({ timeoutMs: String(limit) }));
    }
    return this.#publish(evaluation);
  }

  /**
   * Bloqueo del disco según el kernel: hay peticiones enviadas y ninguna se completa durante
   * `stallMs`. Detecta el caso que las demás comprobaciones no ven: con los metadatos en caché,
   * lstat y la lectura del marcador responden aunque el disco ya no conteste.
   */
  async #checkStall(device: { major: number; minor: number }): Promise<{ stalledMs: number; inFlight: number; recovering: boolean } | null> {
    const stats = (await this.#probe.readBlockStats?.(device)) ?? null;
    const now = this.#options.monotonic?.() ?? performance.now();
    if (stats === null) {
      // Sin contadores (FUSE/ntfs-3g, contenedores): solo se aplica la histéresis de recuperación.
    } else if (stats.inFlight === 0 || this.#io === null || stats.completed !== this.#io.completed) {
      this.#io = { completed: stats.completed, since: now };
    } else {
      const stalledMs = now - this.#io.since;
      if (stalledMs >= (this.#options.stallMs ?? 20_000)) {
        this.#lastStallAt = now;
        return { stalledMs: Math.round(stalledMs), inFlight: stats.inFlight, recovering: false };
      }
    }
    // Recién salido de un bloqueo: se exige un periodo estable antes de volver a usarlo.
    if (this.#lastStallAt !== null && now - this.#lastStallAt < (this.#options.recoveryMs ?? 60_000)) {
      return { stalledMs: 0, inFlight: stats?.inFlight ?? 0, recovering: true };
    }
    this.#lastStallAt = null;
    return null;
  }

  #publish(evaluation: Evaluation): VolumeSnapshot {
    const previous = this.#current;
    const changed = previous.state !== evaluation.state || previous.identity !== evaluation.identity;
    if (changed) this.#generation += 1;
    const snapshot: VolumeSnapshot = {
      state: evaluation.state,
      issues: evaluation.issues,
      generation: this.#generation,
      checkedAt: this.#clock().toISOString(),
      mount: evaluation.mount,
      identity: evaluation.identity,
    };
    this.#current = snapshot;
    if (changed) {
      for (const listener of this.#listeners) {
        try {
          listener(snapshot);
        } catch {
          // Un listener defectuoso no puede alterar la evaluación del volumen.
        }
      }
    }
    return snapshot;
  }

  async #evaluate(): Promise<Evaluation> {
    const options = this.#options;
    const probe = this.#probe;
    const mountpoint = options.mountpoint;

    // 1. Configuración mínima.
    if (options.expectedFsUuid === null) {
      return verdict('NEEDS_CHECK', issue('NOT_CONFIGURED', 'No hay ningún volumen configurado (storage.expected_fs_uuid)'));
    }

    // 2. Tabla de montajes.
    let entries: MountInfoEntry[];
    try {
      entries = parseMountInfo(await probe.readMountInfo());
    } catch (error) {
      return verdict(
        'UNAVAILABLE',
        issue('MOUNTINFO_UNREADABLE', 'No se pudo leer la tabla de montajes', { error: describe(error) }),
      );
    }

    // 3. Directorio de montaje.
    const realMountpoint = await probe.realpath(mountpoint);
    if (realMountpoint === null) {
      return verdict('UNAVAILABLE', issue('NOT_MOUNTED', `El directorio de montaje ${mountpoint} no existe`));
    }
    if (realMountpoint !== mountpoint) {
      return verdict(
        'NEEDS_CHECK',
        issue('MOUNTPOINT_INVALID', 'El punto de montaje no es una ruta canónica (¿enlace simbólico?)', {
          realpath: realMountpoint,
        }),
      );
    }

    // 4. Montaje visible.
    const top = findTopMount(entries, mountpoint);
    if (top.kind === 'none') {
      return verdict('UNAVAILABLE', issue('NOT_MOUNTED', `No hay ningún disco montado en ${mountpoint}`));
    }
    if (top.kind === 'ambiguous') {
      return verdict(
        'UNAVAILABLE',
        issue('MOUNT_AMBIGUOUS', `Hay varios montajes no apilados en ${mountpoint}`, {
          mountIds: top.entries.map((entry) => entry.mountId).join(','),
        }),
      );
    }
    const entry = top.entry;
    const mount = toMountView(entry);

    // 5. ¿Es solo el FS del sistema (microSD) visto a través de un bind?
    const rootTop = findTopMount(entries, '/');
    if (rootTop.kind === 'found' && sameDevice(rootTop.entry, entry)) {
      return verdict(
        'UNAVAILABLE',
        issue('NOT_MOUNTED', `${mountpoint} pertenece al sistema de archivos del sistema, el HDD no está montado`),
        mount,
      );
    }

    // 5 bis. ¿El disco responde? (contadores del kernel, sin tocar el disco).
    const stall = await this.#checkStall(entry);
    if (stall !== null) {
      return verdict(
        'UNHEALTHY',
        stall.recovering
          ? issue('IO_STALLED', 'El disco vuelve a responder: se comprueba que funcione estable antes de usarlo', { recovering: 'sí' })
          : issue('IO_STALLED', 'El disco no responde: hay operaciones esperando sin avanzar', { stalledMs: String(stall.stalledMs), inFlight: String(stall.inFlight) }),
        toMountView(entry),
        this.#current.identity,
      );
    }

    // 6. Coherencia con el kernel en este instante.
    const mountpointInfo = await probe.stat(mountpoint);
    if (mountpointInfo === null || !sameDevice(mountpointInfo.dev, entry)) {
      return verdict(
        'UNAVAILABLE',
        issue('MOUNT_CHANGED', 'El montaje cambió durante la comprobación', {
          mountinfo: formatDevice(entry),
          stat: mountpointInfo === null ? 'ausente' : formatDevice(mountpointInfo.dev),
        }),
        mount,
      );
    }

    // 7. Dispositivo esperado por UUID.
    const byUuidPath = path.join(BY_UUID_DIR, options.expectedFsUuid);
    const expectedDevice = await probe.stat(byUuidPath);
    const sourceReal = entry.source.startsWith('/') ? await probe.realpath(entry.source) : null;
    if (expectedDevice === null || expectedDevice.kind !== 'block-device') {
      const sourceInfo = sourceReal === null ? null : await probe.stat(sourceReal);
      if (sourceInfo?.kind === 'block-device') {
        return verdict(
          'WRONG_VOLUME',
          issue('SOURCE_MISMATCH', 'Hay otro disco montado y el disco configurado no está conectado', {
            mounted: entry.source,
            expectedUuid: options.expectedFsUuid,
          }),
          mount,
        );
      }
      return verdict(
        'UNAVAILABLE',
        issue('DEVICE_ABSENT', 'El disco configurado no está conectado (montaje obsoleto o desconexión)', {
          expectedUuid: options.expectedFsUuid,
          staleSource: entry.source,
        }),
        mount,
      );
    }

    // 8. ¿El montado es el esperado? FUSE (ntfs-3g) usa dispositivos anónimos 0:N.
    const isFuse = entry.fsType === 'fuseblk' || entry.fsType.startsWith('fuse.');
    const expectedPath = await probe.realpath(byUuidPath);
    const matches = isFuse
      ? sourceReal !== null && sourceReal === expectedPath
      : sameDevice(expectedDevice.rdev, entry);
    if (!matches) {
      return verdict(
        'WRONG_VOLUME',
        issue('SOURCE_MISMATCH', 'El disco montado no es el disco configurado', {
          mounted: `${entry.source} (${formatDevice(entry)})`,
          expected: `${expectedPath ?? byUuidPath} (${formatDevice(expectedDevice.rdev)})`,
        }),
        mount,
      );
    }
    const mountIdentity = `${entry.mountId}|${formatDevice(entry)}`;

    // 9. Forma del montaje.
    if (entry.root !== '/') {
      return verdict(
        'NEEDS_CHECK',
        issue('MOUNT_NOT_FS_ROOT', 'Debe montarse el sistema de archivos completo, no un subdirectorio', {
          root: entry.root,
        }),
        mount,
        mountIdentity,
      );
    }
    if (!MOUNTINFO_FSTYPES[options.fsType].includes(entry.fsType)) {
      return verdict(
        'NEEDS_CHECK',
        issue('FSTYPE_UNEXPECTED', 'El tipo de montaje no coincide con el configurado', {
          configured: options.fsType,
          mounted: entry.fsType,
        }),
        mount,
        mountIdentity,
      );
    }
    if (hasMountOption(entry, 'force')) {
      return verdict(
        'NEEDS_CHECK',
        issue('FORCED_MOUNT', 'El volumen se montó con "force" (posible NTFS sucio/hibernado): requiere chkdsk'),
        mount,
        mountIdentity,
      );
    }

    // 10. Directorio interno y marcador.
    const notBound = (detail?: Record<string, string>): Evaluation =>
      options.volumeMarker === null
        ? verdict(
            'NEEDS_CHECK',
            issue('NOT_ONBOARDED', 'El volumen está montado pero aún no se ha vinculado a esta instalación', detail),
            mount,
            `${mountIdentity}|unbound`,
          )
        : verdict(
            'NEEDS_CHECK',
            issue('MARKER_MISSING', `Falta ${INTERNAL_DIR_NAME}/${MARKER_FILE_NAME} en el volumen`, detail),
            mount,
            mountIdentity,
          );

    const internalInfo = await probe.lstat(this.#internalDir);
    if (internalInfo === null) return notBound();
    if (internalInfo.kind !== 'directory' || !sameDevice(internalInfo.dev, entry)) {
      return verdict(
        'NEEDS_CHECK',
        issue('INTERNAL_DIR_INVALID', `${INTERNAL_DIR_NAME} no es un directorio real del volumen`, {
          kind: internalInfo.kind,
        }),
        mount,
        mountIdentity,
      );
    }
    const markerInfo = await probe.lstat(this.#markerPath);
    if (markerInfo === null) return notBound();
    if (markerInfo.kind !== 'file' || !sameDevice(markerInfo.dev, entry) || markerInfo.size > VOLUME_MARKER_MAX_BYTES) {
      return verdict(
        'NEEDS_CHECK',
        issue('MARKER_INVALID', 'El marcador de volumen no es un fichero regular válido', { kind: markerInfo.kind }),
        mount,
        mountIdentity,
      );
    }
    const markerText = await this.#readMarker();
    const markerId = markerText === null ? null : parseVolumeMarker(markerText);
    if (markerId === null) {
      return verdict(
        'NEEDS_CHECK',
        issue('MARKER_INVALID', 'El marcador de volumen está dañado o tiene un formato desconocido'),
        mount,
        mountIdentity,
      );
    }
    if (options.volumeMarker === null) return notBound({ existingMarker: markerId });
    if (markerId !== options.volumeMarker) {
      return verdict(
        'WRONG_VOLUME',
        issue('MARKER_MISMATCH', 'El volumen pertenece a otra instalación (marcador distinto)', {
          expected: options.volumeMarker,
          found: markerId,
        }),
        mount,
        mountIdentity,
      );
    }
    const identity = `${mountIdentity}|${markerId}`;

    // 11. Raíz de datos administrada.
    const dataInfo = await probe.lstat(this.#dataRoot);
    if (dataInfo === null || dataInfo.kind !== 'directory' || !sameDevice(dataInfo.dev, entry)) {
      return verdict(
        'NEEDS_CHECK',
        issue('DATA_ROOT_INVALID', 'La raíz de datos no existe o no es un directorio real del volumen', {
          path: this.#dataRoot,
          kind: dataInfo?.kind ?? 'ausente',
        }),
        mount,
        identity,
      );
    }

    // 12. Escritura.
    if (mount.readOnly) {
      return verdict('READ_ONLY', issue('MOUNT_READ_ONLY', 'El volumen está montado en solo lectura'), mount, identity);
    }
    for (const target of [this.#internalDir, this.#dataRoot]) {
      try {
        await probe.checkWritable(target);
      } catch (error) {
        if (errnoOf(error) === 'EROFS') {
          return verdict(
            'READ_ONLY',
            issue('MOUNT_READ_ONLY', 'El kernel rechaza escrituras en el volumen (EROFS)'),
            mount,
            identity,
          );
        }
        const classified = classifyUnexpected(error);
        return { ...classified, mount, identity };
      }
    }

    return { state: 'READY', issues: [], mount, identity };
  }

  async #readMarker(): Promise<string | null> {
    try {
      return await this.#probe.readTextFile(this.#markerPath, VOLUME_MARKER_MAX_BYTES);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== undefined && IO_ERRNOS.has(code)) throw error;
      return null; // ELOOP (symlink), EFBIG, UTF-8 inválido... → marcador inválido
    }
  }
}

function allows(kind: LeaseKind, snapshot: VolumeSnapshot): boolean {
  switch (kind) {
    case 'write':
      return volumeAllowsMutations(snapshot.state);
    case 'read':
      return volumeAllowsReads(snapshot.state);
    case 'onboarding':
      return (
        snapshot.state === 'NEEDS_CHECK' &&
        snapshot.mount !== null &&
        !snapshot.mount.readOnly &&
        snapshot.issues.length > 0 &&
        snapshot.issues.every((entry) => entry.code === 'NOT_ONBOARDED')
      );
  }
}
