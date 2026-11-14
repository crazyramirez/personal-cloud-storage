/**
 * Vinculación (onboarding) de un volumen con esta instalación (ADR-0004, ADR-0006).
 *
 * Solo actúa bajo un lease de onboarding del StorageGuardian: volumen montado en lectura-escritura,
 * identificado por su UUID y SIN vincular (NEEDS_CHECK con NOT_ONBOARDED como única causa).
 * Crea `.pcloud/{staging,trash,versions}` y la raíz de datos, y escribe `.pcloud/volume-id` de forma
 * atómica: temporal exclusivo → fsync → rename → fsync del directorio → relectura.
 *
 * Nunca borra ni sobrescribe. Si algo existe con un tipo inesperado o en otro dispositivo, se detiene.
 * Si el volumen ya trae marcador (reinstalación, DB perdida), solo lo readopta con permiso explícito.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { posix as path } from 'node:path';
import { syncDirectory } from '../fs/durability.ts';
import { MARKER_FILE_NAME, type VolumeLease, type VolumeSnapshot } from './storage-guardian.ts';
import { formatVolumeMarker, parseVolumeMarker } from './volume-marker.ts';

export const INTERNAL_SUBDIRS = ['staging', 'trash', 'versions'] as const;

/** Lo que necesita el onboarding del StorageGuardian (permite tests sin hardware). */
export interface OnboardingGuardian {
  acquire(kind: 'onboarding'): Promise<VolumeLease>;
  revalidate(lease: VolumeLease): Promise<void>;
  readonly current: VolumeSnapshot;
}

export interface OnboardingOptions {
  /** Readoptar un marcador que ya existe en el volumen. Nunca es el comportamiento por defecto. */
  readonly adoptExistingMarker?: boolean;
  /** Generador del identificador (para tests). Por defecto, UUID v4 aleatorio. */
  readonly newMarkerId?: () => string;
}

export interface OnboardingResult {
  readonly markerId: string;
  readonly adopted: boolean;
  /** Rutas creadas en esta ejecución (las que ya existían no aparecen). */
  readonly created: readonly string[];
}

export class OnboardingError extends Error {
  override readonly name = 'OnboardingError';
}

async function existsNoFollow(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function onboardVolume(
  guardian: OnboardingGuardian,
  options: OnboardingOptions = {},
): Promise<OnboardingResult> {
  const lease = await guardian.acquire('onboarding');
  const existing = guardian.current.issues[0]?.detail?.['existingMarker'];
  if (existing !== undefined && options.adoptExistingMarker !== true) {
    throw new OnboardingError(
      `El volumen ya tiene el marcador ${existing} (¿reinstalación o base de datos perdida?). ` +
        'Solo se readopta con permiso explícito.',
    );
  }

  const volumeDev = (await stat(lease.mountPoint, { bigint: true })).dev;
  const created: string[] = [];
  const ensureDir = async (dir: string): Promise<void> => {
    try {
      await mkdir(dir, { mode: 0o700 });
      created.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(dir, { bigint: true });
    if (!info.isDirectory()) throw new OnboardingError(`${dir} existe y no es un directorio real`);
    if (info.dev !== volumeDev) throw new OnboardingError(`${dir} no está en el volumen montado`);
  };

  await ensureDir(lease.internalDir);
  for (const sub of INTERNAL_SUBDIRS) await ensureDir(path.join(lease.internalDir, sub));
  if (lease.dataRoot !== lease.mountPoint) await ensureDir(lease.dataRoot);

  if (existing !== undefined) return { markerId: existing, adopted: true, created };

  const markerId = (options.newMarkerId ?? randomUUID)();
  const content = formatVolumeMarker(markerId); // valida el formato antes de tocar el disco
  const markerPath = path.join(lease.internalDir, MARKER_FILE_NAME);
  const tmpPath = path.join(lease.internalDir, `${MARKER_FILE_NAME}.tmp-${randomUUID()}`);

  await guardian.revalidate(lease); // justo antes de escribir el marcador (spec §3.4.5)
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(tmpPath, flags, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (await existsNoFollow(markerPath)) {
    throw new OnboardingError('Apareció un marcador durante la vinculación: abortado sin sobrescribirlo');
  }
  await rename(tmpPath, markerPath);
  await syncDirectory(lease.internalDir);

  if (parseVolumeMarker(await readFile(markerPath, 'utf8')) !== markerId) {
    throw new OnboardingError('El marcador escrito no se relee correctamente');
  }
  created.push(markerPath);
  return { markerId, adopted: false, created };
}
