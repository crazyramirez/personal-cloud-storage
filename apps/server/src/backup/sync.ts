/**
 * Motor de sincronización de la copia de seguridad (ADR-0017): deja en el disco de copia un
 * ESPEJO exacto de la nube, sin borrar nunca nada de golpe.
 *
 *  1. Escanea la nube y la copia (tamaño y fecha de modificación de cada archivo).
 *  2. Planifica: archivos nuevos, cambiados (tamaño o fecha distintos) y sobrantes (están en la
 *     copia pero ya no en la nube).
 *  3. Aparta lo sobrante a `.pcloud-backup/archivo/<fecha>/…` (un rename, instantáneo): nada se
 *     borra hasta que caduca el archivo (retentionDays) o hace falta sitio, y siempre lo más antiguo.
 *  4. Copia por lotes: cada archivo a un temporal en su carpeta de destino; al cerrar el lote,
 *     UNA sola orden `sync -f` vuelca el disco entero; solo entonces cada temporal sustituye al
 *     archivo final (y la versión anterior va al archivo). Así un corte de luz nunca deja un
 *     archivo «completo» con contenido basura, y no se paga un vaciado de caché por archivo (en un
 *     HDD USB cuesta ~60 ms cada uno).
 *
 * Antes de cada archivo se comprueba que el disco de copia sigue siendo el mismo dispositivo y que
 * la nube sigue disponible; si no, se para limpiamente. Lo ya copiado vale: la siguiente vez solo
 * se copia lo que falte.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, stat, statfs, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Carpeta del disco de copia que se ve en el PC con el espejo de la nube. */
export const MIRROR_DIR = 'Personal Cloud Storage';
/** Carpeta interna: marca del disco, archivo de lo sustituido o borrado e informes. */
export const META_DIR = '.pcloud-backup';
export const ARCHIVE_DIR = 'archivo';
export const REPORTS_DIR = 'informes';
const TEMP_NAME = /^\.pcloud-sync-[0-9a-f]{16}\.tmp$/;

/** Diferencia de fechas que se considera «la misma» (exFAT guarda 10 ms; algún sistema, 2 s). */
const MTIME_TOLERANCE_MS = 2000;
const BATCH_FILES = 200;
const BATCH_BYTES = 512 * 1024 * 1024;
const BATCH_MS = 15_000;

export interface FileEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

/** Rutas relativas con `/`, sin barra inicial. */
export interface Tree {
  readonly files: Map<string, FileEntry>;
  readonly dirs: Set<string>;
}

export interface ScanOptions {
  readonly signal?: AbortSignal;
  /** Nombres de primer nivel que no se recorren (p. ej. `.pcloud`). */
  readonly skipTop?: (name: string) => boolean;
  /** Borra temporales propios abandonados por una sincronización interrumpida. */
  readonly removeStaleTemps?: boolean;
  readonly onProgress?: (files: number) => void;
}

export class SyncAbortedError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new SyncAbortedError('CANCELLED');
}

const join = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);

/** Recorre un árbol sin seguir enlaces simbólicos; ignora lo que no sea carpeta o archivo regular. */
export async function scanTree(root: string, options: ScanOptions = {}): Promise<Tree> {
  const files = new Map<string, FileEntry>();
  const dirs = new Set<string>();
  const pending: string[] = [''];
  while (pending.length > 0) {
    checkAbort(options.signal);
    const rel = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch (error) {
      if (rel === '' && (error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (rel === '' && options.skipTop?.(name) === true) continue;
      const child = join(rel, name);
      if (entry.isDirectory()) {
        dirs.add(child);
        pending.push(child);
      } else if (entry.isFile()) {
        if (TEMP_NAME.test(name)) {
          if (options.removeStaleTemps === true) await unlink(path.join(root, child)).catch(() => undefined);
          continue;
        }
        const info = await lstat(path.join(root, child)).catch(() => null);
        if (info === null || !info.isFile()) continue;
        files.set(child, { size: info.size, mtimeMs: info.mtimeMs });
        if (files.size % 500 === 0) options.onProgress?.(files.size);
      }
    }
  }
  return { files, dirs };
}

export interface CopyItem {
  readonly rel: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly kind: 'new' | 'changed';
}

export interface SyncPlan {
  readonly copy: CopyItem[];
  /** Carpetas a crear (padres antes que hijas). */
  readonly mkdirs: string[];
  /** Archivos sobrantes cuya carpeta sigue existiendo en la nube. */
  readonly archiveFiles: string[];
  /** Carpetas sobrantes enteras (la más alta de cada rama): se apartan de una vez. */
  readonly archiveDirs: string[];
  readonly summary: {
    newFiles: number;
    changedFiles: number;
    removedFiles: number;
    unchangedFiles: number;
    bytesToCopy: number;
  };
}

const parentOf = (rel: string): string => {
  const index = rel.lastIndexOf('/');
  return index === -1 ? '' : rel.slice(0, index);
};
const depth = (rel: string): number => rel.split('/').length;

export function sameFile(a: FileEntry, b: FileEntry): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) <= MTIME_TOLERANCE_MS;
}

/** Compara la nube (`source`) con la copia (`target`) y decide qué hacer. No toca nada. */
export function planSync(source: Tree, target: Tree): SyncPlan {
  // Carpetas sobrantes: en la copia, no en la nube. Solo la más alta de cada rama.
  const archiveDirs = [...target.dirs]
    .filter((dir) => !source.dirs.has(dir))
    .filter((dir) => {
      const parent = parentOf(dir);
      return parent === '' || source.dirs.has(parent);
    })
    .sort();
  const archivedDir = (rel: string): boolean => {
    for (let parent = parentOf(rel); parent !== ''; parent = parentOf(parent)) {
      if (!source.dirs.has(parent)) return true;
    }
    return false;
  };

  const archiveFiles: string[] = [];
  let removedFiles = 0;
  for (const rel of target.files.keys()) {
    if (source.files.has(rel)) continue;
    removedFiles += 1;
    if (!archivedDir(rel)) archiveFiles.push(rel);
  }
  archiveFiles.sort();

  const copy: CopyItem[] = [];
  let unchanged = 0;
  let bytes = 0;
  for (const [rel, entry] of source.files) {
    const existing = target.files.get(rel);
    if (existing !== undefined && sameFile(entry, existing)) {
      unchanged += 1;
      continue;
    }
    copy.push({ rel, size: entry.size, mtimeMs: entry.mtimeMs, kind: existing === undefined ? 'new' : 'changed' });
    bytes += entry.size;
  }
  // Orden estable por carpeta: el disco de copia escribe de forma más secuencial.
  copy.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  // Carpetas que crear: no existen en la copia o allí son un archivo (que se aparta antes).
  const mkdirs = [...source.dirs].filter((dir) => !target.dirs.has(dir)).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));

  return {
    copy,
    mkdirs,
    archiveFiles,
    archiveDirs,
    summary: {
      newFiles: copy.filter((item) => item.kind === 'new').length,
      changedFiles: copy.filter((item) => item.kind === 'changed').length,
      removedFiles,
      unchangedFiles: unchanged,
      bytesToCopy: bytes,
    },
  };
}

/** Sello de fecha de una sincronización: nombre de carpeta del archivo (orden cronológico). */
export function runStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

export interface ExecuteHooks {
  readonly signal: AbortSignal;
  /** Lanza SyncAbortedError si el disco de copia ya no es el mismo o la nube no está disponible. */
  readonly guard: () => Promise<void>;
  readonly onProgress: (progress: { filesDone: number; bytesDone: number; current: string | null }) => void;
  /** Vaciado de caché del disco de copia (por defecto `sync -f <raíz>`). */
  readonly flush?: ((root: string) => Promise<void>) | undefined;
}

export interface ExecuteResult {
  readonly bytesCopied: number;
  readonly filesCopied: number;
  readonly failed: Array<{ rel: string; code: string }>;
}

async function defaultFlush(root: string): Promise<void> {
  await execFileAsync('sync', ['-f', root], { timeout: 10 * 60 * 1000 });
}

async function moveAside(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
}

const errorCode = (error: unknown): string => {
  if (error instanceof SyncAbortedError) return error.code;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : 'EIO';
};

/** Errores que indican que el disco entero falla: no tiene sentido seguir archivo a archivo. */
const FATAL = new Set(['EIO', 'EROFS', 'ENOSPC', 'ENODEV', 'ENXIO', 'ESTALE', 'ENOTCONN', 'DISK_REMOVED', 'SOURCE_UNAVAILABLE']);

interface Staged {
  readonly item: CopyItem;
  readonly temp: string;
  readonly final: string;
}

/**
 * Aplica un plan. `sourceRoot` es la raíz de datos de la nube; `mirrorRoot`, la carpeta espejo del
 * disco de copia; `archiveRoot`, la carpeta de archivo de ESTA sincronización.
 */
export async function executePlan(plan: SyncPlan, sourceRoot: string, mirrorRoot: string, archiveRoot: string, hooks: ExecuteHooks): Promise<ExecuteResult> {
  const flush = hooks.flush ?? defaultFlush;
  const failed: Array<{ rel: string; code: string }> = [];
  let bytesDone = 0;
  let filesDone = 0;
  const fail = (rel: string, error: unknown): void => {
    const code = errorCode(error);
    if (FATAL.has(code)) throw error instanceof SyncAbortedError ? error : new SyncAbortedError(code === 'ENOSPC' ? 'NO_SPACE' : code === 'EROFS' ? 'READ_ONLY' : 'DISK_ERROR');
    failed.push({ rel, code });
  };

  await mkdir(mirrorRoot, { recursive: true });

  // 1. Apartar lo sobrante (antes de copiar: resuelve choques de nombre y de tipo carpeta/archivo).
  for (const rel of [...plan.archiveDirs, ...plan.archiveFiles]) {
    checkAbort(hooks.signal);
    await hooks.guard();
    try {
      await moveAside(path.join(mirrorRoot, rel), path.join(archiveRoot, rel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(rel, error);
    }
  }

  // 2. Carpetas nuevas.
  for (const rel of plan.mkdirs) {
    checkAbort(hooks.signal);
    try {
      await mkdir(path.join(mirrorRoot, rel), { recursive: true });
    } catch (error) {
      fail(rel, error);
    }
  }

  // 3. Copias por lotes.
  let batch: Staged[] = [];
  let batchBytes = 0;
  let batchStarted = Date.now();

  const commit = async (): Promise<void> => {
    if (batch.length === 0) return;
    await hooks.guard();
    await flush(mirrorRoot);
    for (const staged of batch) {
      try {
        if (staged.item.kind === 'changed') {
          try {
            await moveAside(staged.final, path.join(archiveRoot, staged.item.rel));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await rename(staged.temp, staged.final);
        filesDone += 1;
      } catch (error) {
        await unlink(staged.temp).catch(() => undefined);
        fail(staged.item.rel, error);
      }
    }
    batch = [];
    batchBytes = 0;
    batchStarted = Date.now();
    hooks.onProgress({ filesDone, bytesDone, current: null });
  };

  try {
    for (const item of plan.copy) {
      checkAbort(hooks.signal);
      await hooks.guard();
      hooks.onProgress({ filesDone, bytesDone, current: item.rel });
      const final = path.join(mirrorRoot, item.rel);
      const temp = path.join(path.dirname(final), `.pcloud-sync-${randomBytes(8).toString('hex')}.tmp`);
      try {
        const copied = await copyOne(path.join(sourceRoot, item.rel), temp, hooks, (delta) => {
          bytesDone += delta;
          hooks.onProgress({ filesDone, bytesDone, current: item.rel });
        });
        if (copied) {
          batch.push({ item, temp, final });
          batchBytes += item.size;
        }
      } catch (error) {
        await unlink(temp).catch(() => undefined);
        if (error instanceof SyncAbortedError && error.code === 'CANCELLED') throw error;
        fail(item.rel, error);
      }
      if (batch.length >= BATCH_FILES || batchBytes >= BATCH_BYTES || Date.now() - batchStarted >= BATCH_MS) await commit();
    }
    await commit();
  } catch (error) {
    // Lo que quedó en temporales sin confirmar se descarta (la próxima vez se copia de nuevo).
    await Promise.all(batch.map((staged) => unlink(staged.temp).catch(() => undefined)));
    throw error;
  }
  return { bytesCopied: bytesDone, filesCopied: filesDone, failed };
}

/**
 * Copia un archivo a `temp` y le pone la fecha de la original. Si la original cambia mientras se
 * copia (alguien la está subiendo o editando), se descarta: se copiará en la próxima sincronización.
 */
async function copyOne(
  from: string,
  temp: string,
  hooks: ExecuteHooks,
  onBytes: (delta: number) => void,
): Promise<boolean> {
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  let written = 0;
  try {
    const before = await source.stat();
    if (!before.isFile()) return false;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        onBytes(chunk.length);
        callback(null, chunk);
      },
    });
    await pipeline(
      source.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 }),
      counter,
      createWriteStream(temp, { flags: 'wx', mode: 0o600, highWaterMark: 1024 * 1024 }),
      { signal: hooks.signal },
    ).catch((error: unknown) => {
      if (hooks.signal.aborted) throw new SyncAbortedError('CANCELLED');
      throw error;
    });
    const after = await source.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || written !== after.size) {
      onBytes(-written);
      await unlink(temp).catch(() => undefined);
      throw Object.assign(new Error('cambió durante la copia'), { code: 'CHANGED_DURING_COPY' });
    }
    const mtime = new Date(after.mtimeMs);
    await utimes(temp, mtime, mtime);
    return true;
  } finally {
    await source.close();
  }
}

// ── Archivo de lo sustituido y lo borrado ───────────────────────────────────────────────────

/** Carpetas de archivo (por fecha) más antiguas que `retentionDays`, o todas si `all`. */
export async function listArchives(archiveBase: string): Promise<Array<{ name: string; date: Date }>> {
  const names = await readdir(archiveBase).catch(() => [] as string[]);
  return names
    .map((name) => {
      const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/.exec(name);
      return match === null ? null : { name, date: new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}Z`) };
    })
    .filter((entry): entry is { name: string; date: Date } => entry !== null && !Number.isNaN(entry.date.getTime()))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Borra el archivo caducado. Devuelve cuántas carpetas de fecha se han borrado. */
export async function purgeExpiredArchives(archiveBase: string, retentionDays: number, now: Date): Promise<number> {
  const limit = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const archive of await listArchives(archiveBase)) {
    if (archive.date.getTime() >= limit) break;
    await rm(path.join(archiveBase, archive.name), { recursive: true, force: true });
    purged += 1;
  }
  return purged;
}

export async function freeBytes(root: string): Promise<{ free: number; total: number }> {
  const info = await statfs(root);
  return { free: info.bavail * info.bsize, total: info.blocks * info.bsize };
}

/** Margen que se deja libre siempre en el disco de copia. */
export function reserveFor(total: number): number {
  return Math.max(1024 ** 3, Math.round(total * 0.01));
}

/**
 * Hace sitio para `needed` bytes borrando el archivo MÁS ANTIGUO primero (nunca el espejo).
 * Devuelve true si al final cabe.
 */
export async function makeRoom(root: string, archiveBase: string, needed: number, keep: string | null): Promise<boolean> {
  for (;;) {
    const { free, total } = await freeBytes(root);
    if (free - reserveFor(total) >= needed) return true;
    const oldest = (await listArchives(archiveBase)).find((archive) => archive.name !== keep);
    if (oldest === undefined) return false;
    await rm(path.join(archiveBase, oldest.name), { recursive: true, force: true });
  }
}

export async function exists(target: string): Promise<boolean> {
  return stat(target).then(() => true, () => false);
}
