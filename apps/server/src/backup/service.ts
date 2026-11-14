/**
 * Copia de seguridad en un disco USB externo (ADR-0017).
 *
 * Flujo:
 *  - Cada pocos segundos mira qué discos externos hay (sin montarlos). Si aparece el disco
 *    asignado, la web pregunta si sincronizar (o empieza sola con `autoSync`). Si aparece otro
 *    disco compatible, la web ofrece asignarlo como disco de copia.
 *  - Asignar: el agente root lo monta, se escribe la marca `.pcloud-backup/backup-id` y se
 *    desmonta. Nada más se toca.
 *  - Sincronizar: montar → comprobar marca → escanear → planificar → (confirmar si hay muchos
 *    borrados o la nube aparece vacía) → hacer sitio con el archivo más antiguo → copiar →
 *    informe → desmontar. Al terminar se puede desconectar el disco sin más.
 *
 * Nunca se escribe en el disco de copia sin comprobar antes que /srv/pcloud-backup es ESE
 * dispositivo (st_dev == st_rdev de /dev/disk/by-uuid/<UUID>); sin disco, el punto de montaje es
 * inmutable y nada puede acabar en la tarjeta del sistema.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  BackupAssignedView,
  BackupDiskView,
  BackupPhase,
  BackupPlanSummary,
  BackupProgress,
  BackupRunView,
  BackupStatusResponse,
} from '@pcloud/contracts';
import { audit } from '../auth/sessions.ts';
import type { Db } from '../db/database.ts';
import { AppError } from '../errors.ts';
import { isReservedTopName } from '../storage/paths.ts';
import type { MountAgent } from './agent.ts';
import type { DiskLister, ExternalDisk } from './disks.ts';
import { BACKUP_MARKER_FILE, formatBackupMarker, parseBackupMarker } from './marker.ts';
import {
  ARCHIVE_DIR,
  executePlan,
  makeRoom,
  META_DIR,
  MIRROR_DIR,
  planSync,
  purgeExpiredArchives,
  REPORTS_DIR,
  runStamp,
  scanTree,
  SyncAbortedError,
  type ExecuteHooks,
  type SyncPlan,
} from './sync.ts';

export interface BackupLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface BackupServiceDeps {
  readonly db: Db;
  readonly agent: MountAgent;
  readonly disks: DiskLister;
  /** Punto de montaje del disco de copia (protegido: root 0555 + inmutable). */
  readonly mountpoint: string;
  /** Raíz de datos de la nube. */
  readonly sourceRoot: string;
  /** La nube se puede leer (StorageGuardian READY o READ_ONLY). */
  readonly sourceReady: () => boolean;
  readonly clock?: () => Date;
  readonly log: BackupLogger;
  /** Ruta del dispositivo por UUID (en pruebas, un fichero cualquiera). */
  readonly devicePath?: (uuid: string) => string;
  /** Comprobación de identidad del montaje (en pruebas se sustituye). */
  readonly verifyMount?: (mountpoint: string, devicePath: string) => Promise<boolean>;
  readonly flush?: ExecuteHooks['flush'];
}

const DEFAULT_RETENTION_DAYS = 90;
/** Por encima de esto, los borrados se confirman antes de sincronizar. */
const DELETE_CONFIRM_MIN = 100;
const DELETE_CONFIRM_RATIO = 0.25;
const CONFIRM_TIMEOUT_MS = 30 * 60 * 1000;
const RELIST_MS = 30_000;

async function sameDevice(mountpoint: string, devicePath: string): Promise<boolean> {
  try {
    const [mounted, device] = await Promise.all([stat(mountpoint, { bigint: true }), stat(devicePath, { bigint: true })]);
    return device.isBlockDevice() && mounted.dev === device.rdev;
  } catch {
    return false;
  }
}

const AGENT_PROBLEM: Record<string, string> = {
  AGENT_UNAVAILABLE: 'AGENT_UNAVAILABLE',
  NOT_FOUND: 'DISK_NOT_CONNECTED',
  READ_ONLY: 'READ_ONLY',
};

interface AssignedRow {
  fsUuid: string;
  marker: string;
  label: string | null;
  model: string | null;
  sizeBytes: number;
  assignedAt: string;
}

export class BackupService {
  readonly #d: BackupServiceDeps;
  readonly #clock: () => Date;
  #phase: BackupPhase = 'idle';
  #disks: ExternalDisk[] = [];
  readonly #connectedAt = new Map<string, string>();
  #fingerprint: string | null = null;
  #listedAt = 0;
  #timer: ReturnType<typeof setInterval> | null = null;
  #polling = false;
  #progress: BackupProgress | null = null;
  #pendingPlan: BackupPlanSummary | null = null;
  #confirm: ((ok: boolean) => void) | null = null;
  #abort: AbortController | null = null;
  #problem: string | null = null;
  #agentReady = false;
  #running: Promise<void> | null = null;

  constructor(deps: BackupServiceDeps) {
    this.#d = deps;
    this.#clock = deps.clock ?? (() => new Date());
  }

  // ── Ciclo de vida ───────────────────────────────────────────────────────────────────────

  async start(intervalMs = 3000): Promise<void> {
    // Una sincronización que se cortó por un reinicio del servicio queda como fallida.
    this.#d.db.prepare("UPDATE backup_runs SET result = 'failed', error = 'INTERRUPTED', finished_at = ? WHERE result = 'running'").run(this.#clock().toISOString());
    this.#agentReady = await this.#d.agent.ready();
    await this.poll();
    // Si el disco de copia quedó montado (reinicio a mitad), se desmonta: nunca se deja montado.
    const assigned = this.#assigned();
    if (assigned !== null && this.#disks.some((disk) => disk.uuid === assigned.fsUuid && disk.mountpoint !== null)) {
      void this.#d.agent.request('unmount', assigned.fsUuid);
    }
    this.#timer = setInterval(() => void this.poll(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
  }

  /** Mira los discos conectados; con el disco asignado recién conectado y `autoSync`, empieza. */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    try {
      const fingerprint = await this.#d.disks.fingerprint();
      const now = Date.now();
      if (fingerprint === this.#fingerprint && now - this.#listedAt < RELIST_MS) return;
      this.#fingerprint = fingerprint;
      this.#listedAt = now;
      const disks = await this.#d.disks.list();
      const at = this.#clock().toISOString();
      const fresh: string[] = [];
      for (const disk of disks) {
        if (!this.#connectedAt.has(disk.uuid)) {
          this.#connectedAt.set(disk.uuid, at);
          fresh.push(disk.uuid);
        }
      }
      for (const uuid of [...this.#connectedAt.keys()]) {
        if (!disks.some((disk) => disk.uuid === uuid)) this.#connectedAt.delete(uuid);
      }
      this.#disks = disks;
      this.#agentReady = await this.#d.agent.ready();
      const assigned = this.#assigned();
      if (assigned !== null && fresh.includes(assigned.fsUuid)) {
        this.#d.log.info({ uuid: assigned.fsUuid }, 'disco de copia conectado');
        if (this.#setting('auto_sync') === '1' && this.#phase === 'idle') this.startSync(false).catch(() => undefined);
      }
    } catch (error) {
      this.#d.log.warn({ err: error }, 'no se pudieron listar los discos externos');
    } finally {
      this.#polling = false;
    }
  }

  // ── Consultas ───────────────────────────────────────────────────────────────────────────

  status(): BackupStatusResponse {
    const assigned = this.#assigned();
    const lastSuccess = this.#d.db.prepare("SELECT finished_at FROM backup_runs WHERE result IN ('ok', 'ok_with_errors') ORDER BY id DESC LIMIT 1").get();
    return {
      phase: this.#phase,
      assigned: assigned === null ? null : this.#assignedView(assigned),
      disks: this.#disks.map((disk) => this.#diskView(disk, assigned)),
      assignedConnected: assigned !== null && this.#disks.some((disk) => disk.uuid === assigned.fsUuid),
      autoSync: this.#setting('auto_sync') === '1',
      retentionDays: this.#retentionDays(),
      progress: this.#progress,
      pendingPlan: this.#pendingPlan,
      lastRun: this.history(1)[0] ?? null,
      lastSuccessAt: lastSuccess === undefined ? null : String(lastSuccess['finished_at']),
      problem: this.#problem,
      agentReady: this.#agentReady,
    };
  }

  history(limit = 20): BackupRunView[] {
    return this.#d.db
      .prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        id: Number(row['id']),
        startedAt: String(row['started_at']),
        finishedAt: row['finished_at'] === null ? null : String(row['finished_at']),
        result: String(row['result']) as BackupRunView['result'],
        error: row['error'] === null ? null : String(row['error']),
        summary: {
          newFiles: Number(row['new_files']),
          changedFiles: Number(row['changed_files']),
          removedFiles: Number(row['removed_files']),
          unchangedFiles: Number(row['unchanged_files']),
          bytesToCopy: Number(row['bytes_to_copy']),
        },
        bytesCopied: Number(row['bytes_copied']),
        failedFiles: Number(row['failed_files']),
      }));
  }

  // ── Acciones ────────────────────────────────────────────────────────────────────────────

  /** Asigna un disco conectado como disco de copia (escribe su marca; no borra nada). */
  async assign(uuid: string, userId: number): Promise<void> {
    if (this.#phase !== 'idle') throw new AppError('CONFLICT', 'Hay una copia en curso');
    await this.poll();
    const disk = this.#disks.find((item) => item.uuid === uuid);
    if (disk === undefined) throw new AppError('NOT_FOUND', 'Ese disco no está conectado');
    if (!disk.compatible) throw new AppError('VALIDATION_FAILED', 'El disco tiene que estar en exFAT o NTFS');
    this.#phase = 'mounting';
    this.#problem = null;
    try {
      await this.#mount(uuid);
      const metaDir = path.join(this.#d.mountpoint, META_DIR);
      await mkdir(metaDir, { recursive: true });
      // Si el disco ya fue el de copia de esta nube (por ejemplo, se desasignó), conserva su marca.
      const existing = parseBackupMarker(await readFile(path.join(metaDir, BACKUP_MARKER_FILE), 'utf8').catch(() => ''));
      const marker = existing ?? randomUUID();
      if (existing === null) {
        const temp = path.join(metaDir, `.${BACKUP_MARKER_FILE}.tmp`);
        await writeFile(temp, formatBackupMarker(marker), { mode: 0o600 });
        await rename(temp, path.join(metaDir, BACKUP_MARKER_FILE));
      }
      await mkdir(path.join(this.#d.mountpoint, MIRROR_DIR), { recursive: true });
      const now = this.#clock().toISOString();
      this.#d.db.prepare('DELETE FROM backup_disk').run();
      this.#d.db
        .prepare('INSERT INTO backup_disk (id, fs_uuid, marker, label, model, size_bytes, assigned_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
        .run(uuid, marker, disk.label, disk.model, disk.sizeBytes, now);
      audit(this.#d.db, { userId, action: 'backup.assign', result: 'ok', detail: `${uuid} ${disk.label ?? ''}`.trim() }, this.#clock());
      this.#d.log.info({ uuid }, 'disco de copia asignado');
    } finally {
      await this.#unmount(uuid);
      this.#phase = 'idle';
    }
  }

  unassign(userId: number): void {
    if (this.#phase !== 'idle') throw new AppError('CONFLICT', 'Hay una copia en curso');
    this.#d.db.prepare('DELETE FROM backup_disk').run();
    audit(this.#d.db, { userId, action: 'backup.unassign', result: 'ok' }, this.#clock());
  }

  setSettings(settings: { autoSync?: boolean; retentionDays?: number }): void {
    if (settings.autoSync !== undefined) this.#setSetting('auto_sync', settings.autoSync ? '1' : '0');
    if (settings.retentionDays !== undefined) this.#setSetting('retention_days', String(settings.retentionDays));
  }

  /**
   * Empieza (o confirma) una sincronización. Devuelve en cuanto arranca; el progreso se consulta
   * con status().
   */
  async startSync(confirm: boolean, userId: number | null = null): Promise<void> {
    if (this.#phase === 'confirm') {
      if (!confirm) throw new AppError('CONFLICT', 'La sincronización espera confirmación');
      this.#confirm?.(true);
      return;
    }
    if (this.#phase !== 'idle') throw new AppError('CONFLICT', 'Ya hay una copia en curso');
    const assigned = this.#assigned();
    if (assigned === null) throw new AppError('PRECONDITION_FAILED', 'No hay ningún disco de copia asignado');
    this.#phase = 'mounting';
    this.#problem = null;
    this.#running = this.#run(assigned, confirm, userId).finally(() => {
      this.#running = null;
    });
  }

  cancel(): void {
    if (this.#phase === 'confirm') this.#confirm?.(false);
    this.#abort?.abort();
  }

  async eject(): Promise<void> {
    if (this.#phase !== 'idle') throw new AppError('CONFLICT', 'Hay una copia en curso: cancélala antes');
    const assigned = this.#assigned();
    if (assigned === null) return;
    this.#phase = 'ejecting';
    try {
      const result = await this.#d.agent.request('unmount', assigned.fsUuid);
      if (!result.ok) throw new AppError('CONFLICT', 'No se pudo expulsar el disco; vuelve a intentarlo');
    } finally {
      this.#phase = 'idle';
    }
  }

  /** Para pruebas: espera a que termine la sincronización en curso. */
  async settled(): Promise<void> {
    await this.#running;
  }

  // ── Sincronización ──────────────────────────────────────────────────────────────────────

  async #run(assigned: AssignedRow, confirmed: boolean, userId: number | null): Promise<void> {
    const startedAt = this.#clock();
    const runId = Number(
      this.#d.db.prepare("INSERT INTO backup_runs (disk_uuid, started_at, result) VALUES (?, ?, 'running')").run(assigned.fsUuid, startedAt.toISOString()).lastInsertRowid,
    );
    const abort = new AbortController();
    this.#abort = abort;
    let summary: BackupPlanSummary = { newFiles: 0, changedFiles: 0, removedFiles: 0, unchangedFiles: 0, bytesToCopy: 0 };
    let bytesCopied = 0;
    let failedFiles = 0;
    let result: BackupRunView['result'] = 'failed';
    let error: string | null = null;
    let mounted = false;
    const uuid = assigned.fsUuid;
    try {
      if (!this.#disks.some((disk) => disk.uuid === uuid)) throw new SyncAbortedError('DISK_NOT_CONNECTED');
      if (!this.#d.sourceReady()) throw new SyncAbortedError('SOURCE_UNAVAILABLE');
      this.#phase = 'mounting';
      await this.#mount(uuid);
      mounted = true;
      const guard = async (): Promise<void> => {
        if (!(await this.#isMounted(uuid))) throw new SyncAbortedError('DISK_REMOVED');
        if (!this.#d.sourceReady()) throw new SyncAbortedError('SOURCE_UNAVAILABLE');
      };
      await guard();
      const metaDir = path.join(this.#d.mountpoint, META_DIR);
      const marker = parseBackupMarker(await readFile(path.join(metaDir, BACKUP_MARKER_FILE), 'utf8').catch(() => ''));
      if (marker !== assigned.marker) throw new SyncAbortedError('DISK_MISMATCH');

      this.#phase = 'scanning';
      this.#progress = { filesTotal: 0, filesDone: 0, bytesTotal: 0, bytesDone: 0, current: null, bytesPerSecond: 0 };
      const mirrorRoot = path.join(this.#d.mountpoint, MIRROR_DIR);
      const [source, target] = await Promise.all([
        scanTree(this.#d.sourceRoot, { signal: abort.signal, skipTop: isReservedTopName }),
        scanTree(mirrorRoot, { signal: abort.signal, removeStaleTemps: true }),
      ]);
      const plan = planSync(source, target);
      summary = plan.summary;

      // Salvaguardas: una nube vacía o que «ha perdido» muchos archivos se confirma antes.
      const suspicious =
        (source.files.size === 0 && target.files.size > 0) ||
        (plan.summary.removedFiles >= DELETE_CONFIRM_MIN && plan.summary.removedFiles >= target.files.size * DELETE_CONFIRM_RATIO);
      if (suspicious && !confirmed) {
        if (source.files.size === 0) this.#problem = 'SOURCE_EMPTY';
        const ok = await this.#awaitConfirmation(plan.summary, abort.signal);
        this.#problem = null;
        if (!ok) throw new SyncAbortedError('CANCELLED');
        await guard();
      }

      const archiveBase = path.join(metaDir, ARCHIVE_DIR);
      const stamp = runStamp(startedAt);
      await purgeExpiredArchives(archiveBase, this.#retentionDays(), this.#clock()).catch(() => 0);
      if (!(await makeRoom(this.#d.mountpoint, archiveBase, plan.summary.bytesToCopy, stamp))) throw new SyncAbortedError('NO_SPACE');

      this.#phase = 'copying';
      const outcome = await this.#copy(plan, mirrorRoot, path.join(archiveBase, stamp), guard, abort.signal);
      bytesCopied = outcome.bytesCopied;
      failedFiles = outcome.failed.length;

      this.#phase = 'finishing';
      await this.#writeReport(metaDir, stamp, startedAt, plan, outcome.failed);
      await rmdir(path.join(archiveBase, stamp)).catch(() => undefined); // vacía = sin cambios que guardar
      result = failedFiles === 0 ? 'ok' : 'ok_with_errors';
    } catch (caught) {
      const code = caught instanceof SyncAbortedError ? caught.code : 'DISK_ERROR';
      if (code === 'CANCELLED') {
        result = 'cancelled';
      } else {
        error = code;
        this.#problem = AGENT_PROBLEM[code] ?? code;
        this.#d.log.warn({ err: caught, code }, 'copia de seguridad interrumpida');
      }
    } finally {
      this.#abort = null;
      this.#confirm = null;
      this.#pendingPlan = null;
      if (mounted || this.#disks.some((disk) => disk.uuid === uuid && disk.mountpoint !== null)) {
        this.#phase = 'ejecting';
        await this.#unmount(uuid);
      }
      this.#progress = null;
      this.#d.db
        .prepare(
          `UPDATE backup_runs SET finished_at = ?, result = ?, error = ?, new_files = ?, changed_files = ?, removed_files = ?,
             unchanged_files = ?, bytes_to_copy = ?, bytes_copied = ?, failed_files = ? WHERE id = ?`,
        )
        .run(
          this.#clock().toISOString(),
          result,
          error,
          summary.newFiles,
          summary.changedFiles,
          summary.removedFiles,
          summary.unchangedFiles,
          summary.bytesToCopy,
          bytesCopied,
          failedFiles,
          runId,
        );
      audit(this.#d.db, { userId, action: 'backup.sync', result: result === 'failed' ? 'error' : 'ok', detail: `${result}${error === null ? '' : ` ${error}`}` }, this.#clock());
      this.#d.log.info({ result, error, summary, bytesCopied, failedFiles }, 'copia de seguridad terminada');
      this.#phase = 'idle';
      // Fuerza a releer los discos (el montaje cambió).
      this.#fingerprint = null;
    }
  }

  async #copy(plan: SyncPlan, mirrorRoot: string, archiveRoot: string, guard: () => Promise<void>, signal: AbortSignal) {
    const total = plan.summary.bytesToCopy;
    const progress: BackupProgress = { filesTotal: plan.copy.length, filesDone: 0, bytesTotal: total, bytesDone: 0, current: null, bytesPerSecond: 0 };
    this.#progress = progress;
    let sampleAt = Date.now();
    let sampleBytes = 0;
    return executePlan(plan, this.#d.sourceRoot, mirrorRoot, archiveRoot, {
      signal,
      guard,
      flush: this.#d.flush,
      onProgress: ({ filesDone, bytesDone, current }) => {
        const now = Date.now();
        if (now - sampleAt >= 1000) {
          const instant = ((bytesDone - sampleBytes) * 1000) / (now - sampleAt);
          progress.bytesPerSecond = progress.bytesPerSecond === 0 ? instant : progress.bytesPerSecond * 0.7 + instant * 0.3;
          sampleAt = now;
          sampleBytes = bytesDone;
        }
        progress.filesDone = filesDone;
        progress.bytesDone = Math.min(bytesDone, total);
        progress.current = current;
      },
    });
  }

  #awaitConfirmation(summary: BackupPlanSummary, signal: AbortSignal): Promise<boolean> {
    this.#phase = 'confirm';
    this.#pendingPlan = summary;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), CONFIRM_TIMEOUT_MS);
      const onAbort = (): void => finish(false);
      const finish = (ok: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.#confirm = null;
        this.#pendingPlan = null;
        resolve(ok);
      };
      signal.addEventListener('abort', onAbort);
      this.#confirm = finish;
    });
  }

  async #writeReport(metaDir: string, stamp: string, startedAt: Date, plan: SyncPlan, failed: Array<{ rel: string; code: string }>): Promise<void> {
    const dir = path.join(metaDir, REPORTS_DIR);
    await mkdir(dir, { recursive: true });
    const report = {
      startedAt: startedAt.toISOString(),
      finishedAt: this.#clock().toISOString(),
      summary: plan.summary,
      failed: failed.slice(0, 2000),
    };
    await writeFile(path.join(dir, `${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }

  // ── Montaje ─────────────────────────────────────────────────────────────────────────────

  #devicePath(uuid: string): string {
    return this.#d.devicePath?.(uuid) ?? `/dev/disk/by-uuid/${uuid}`;
  }

  async #isMounted(uuid: string): Promise<boolean> {
    const verify = this.#d.verifyMount ?? sameDevice;
    return verify(this.#d.mountpoint, this.#devicePath(uuid));
  }

  async #mount(uuid: string): Promise<void> {
    const result = await this.#d.agent.request('mount', uuid);
    if (!result.ok) throw new SyncAbortedError(AGENT_PROBLEM[result.code] ?? 'MOUNT_FAILED');
    if (!(await this.#isMounted(uuid))) throw new SyncAbortedError('MOUNT_FAILED');
  }

  async #unmount(uuid: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.#d.agent.request('unmount', uuid).catch(() => ({ ok: false, code: 'AGENT_UNAVAILABLE' as const }));
      if (result.ok || result.code === 'AGENT_UNAVAILABLE') return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.#d.log.warn({ uuid }, 'no se pudo desmontar el disco de copia');
  }

  // ── Datos ───────────────────────────────────────────────────────────────────────────────

  #assigned(): AssignedRow | null {
    const row = this.#d.db.prepare('SELECT * FROM backup_disk WHERE id = 1').get();
    if (row === undefined) return null;
    return {
      fsUuid: String(row['fs_uuid']),
      marker: String(row['marker']),
      label: row['label'] === null ? null : String(row['label']),
      model: row['model'] === null ? null : String(row['model']),
      sizeBytes: Number(row['size_bytes']),
      assignedAt: String(row['assigned_at']),
    };
  }

  #assignedView(row: AssignedRow): BackupAssignedView {
    return { uuid: row.fsUuid, label: row.label, model: row.model, sizeBytes: row.sizeBytes, assignedAt: row.assignedAt };
  }

  #diskView(disk: ExternalDisk, assigned: AssignedRow | null): BackupDiskView {
    return {
      uuid: disk.uuid,
      fsType: disk.fsType,
      compatible: disk.compatible,
      sizeBytes: disk.sizeBytes,
      label: disk.label,
      model: disk.model,
      assigned: assigned !== null && assigned.fsUuid === disk.uuid,
      connectedAt: this.#connectedAt.get(disk.uuid) ?? this.#clock().toISOString(),
    };
  }

  #setting(key: string): string | null {
    const row = this.#d.db.prepare('SELECT value FROM backup_settings WHERE key = ?').get(key);
    return row === undefined ? null : String(row['value']);
  }

  #setSetting(key: string, value: string): void {
    this.#d.db.prepare('INSERT INTO backup_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  #retentionDays(): number {
    const value = Number(this.#setting('retention_days'));
    return Number.isInteger(value) && value >= 7 ? value : DEFAULT_RETENTION_DAYS;
  }
}
