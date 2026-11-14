/**
 * Operaciones del explorador: crear archivo, renombrar, mover, copiar y papelera.
 *
 * Reglas comunes (spec §3.4, ADR-0009):
 *  - Toda escritura exige un lease de escritura del StorageGuardian y lo revalida justo antes de
 *    cada paso que modifica el disco.
 *  - NUNCA se sobrescribe nada: renombrar a un nombre ocupado es 409; mover o copiar a una carpeta
 *    donde el nombre existe usa «nombre (2)». La comprobación y el rename van en la misma cola
 *    serie que los commits de subidas (no hay carreras dentro del proceso).
 *  - «Eliminar» = mover a `.pcloud/trash` en el MISMO volumen (rename atómico). El borrado
 *    definitivo solo existe dentro de la papelera.
 *  - Tras cada rename se sincronizan los directorios afectados; las copias se construyen en
 *    `.pcloud/staging` y aparecen en el destino con un único rename, ya sincronizadas.
 *  - Los pasos de varias fases dejan rastro en disco para que `recover()` los resuelva tras un
 *    corte, sin borrar nunca datos del usuario.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, rmdir, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { ItemResult, TrashEntry, TrashListResponse } from '@pcloud/contracts';
import { AppError, errnoOf } from '../errors.ts';
import { syncDirectory } from '../fs/durability.ts';
import { createFolder as createFolderIn } from './files.ts';
import { checkNewName, foldKey, portabilityIssue, uniqueName } from './names.ts';
import { formatClientPath, isReservedTopName, parseClientPath, resolveInside } from './paths.ts';
import type { SerialQueue } from './serial.ts';
import { assertSpaceFor } from './space.ts';
import { StorageUnavailableError, type VolumeLease } from './storage-guardian.ts';
import type { VolumeGate } from './uploads.ts';

/** Máximo de elementos (archivos + carpetas) que puede abarcar una copia. */
export const MAX_COPY_ENTRIES = 20_000;
const TRASH_ID = /^[0-9]{13}-[0-9a-f]{8}$/;
const TRASH_META = 'meta.json';
const TRASH_ITEM = 'item';
const COPY_SUFFIX = '.copy';
const RENAME_INTENT_SUFFIX = '.rename.json';
const RENAMING_SUFFIX = '.renaming';
const VOLUME_ERRNOS = new Set(['EIO', 'ENODEV', 'ENXIO', 'EROFS', 'ESTALE', 'ENOTCONN']);
const COPY_BUFFER = 1024 * 1024;

export interface FsOperationsOptions {
  readonly gate: VolumeGate;
  readonly serial: SerialQueue;
  readonly minFreePercent: number;
  readonly minFreeBytes: number;
  /** Días que se conservan los elementos en la papelera; null = sin caducidad automática. */
  readonly trashRetentionDays: number | null;
  readonly clock?: () => Date;
  /**
   * ¿La hora del sistema es fiable? La Pi no tiene reloj propio: tras días apagada y sin red
   * arranca con una hora antigua, y un salto de reloj podría vaciar la papelera de golpe. Sin
   * hora fiable no se elimina nada por caducidad.
   */
  readonly clockTrusted?: () => Promise<boolean>;
}

interface TrashMeta {
  readonly v: 1;
  readonly name: string;
  readonly originalPath: string;
  readonly type: 'dir' | 'file';
  readonly size: number;
  readonly deletedAt: string;
  readonly deletedBy: number | null;
}

interface RenameIntent {
  readonly v: 1;
  readonly tmp: string;
  /** Segmentos de la ruta final relativos a la raíz de datos. */
  readonly target: string[];
}

/** Elemento de un árbol recorrido con lstat (sin seguir enlaces). */
interface WalkEntry {
  readonly abs: string;
  /** Ruta relativa a la raíz del recorrido, con «/». '' = la propia raíz. */
  readonly rel: string;
  readonly stats: Stats;
}

/** Recorre un árbol en preorden con lstat. Nunca sigue enlaces simbólicos. */
export async function* walkTree(root: string, rootStats?: Stats): AsyncGenerator<WalkEntry> {
  const stats = rootStats ?? (await lstat(root));
  yield { abs: root, rel: '', stats };
  if (!stats.isDirectory()) return;
  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];
  while (stack.length > 0) {
    const dir = stack.pop() as { abs: string; rel: string };
    const names = (await readdir(dir.abs)).sort();
    for (const name of names) {
      const abs = path.join(dir.abs, name);
      const rel = dir.rel === '' ? name : `${dir.rel}/${name}`;
      let childStats: Stats;
      try {
        childStats = await lstat(abs);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') continue;
        throw error;
      }
      yield { abs, rel, stats: childStats };
      if (childStats.isDirectory()) stack.push({ abs, rel });
    }
  }
}

/** Traduce un error de una operación de un elemento a su resultado. `fatal`: no seguir con el lote. */
function failureOf(error: unknown): { code: string; message: string; fatal: boolean } {
  if (error instanceof StorageUnavailableError) return { code: 'STORAGE_UNAVAILABLE', message: error.message, fatal: true };
  if (error instanceof AppError) return { code: error.code, message: error.message, fatal: error.code === 'STORAGE_UNAVAILABLE' };
  const errno = errnoOf(error);
  if (errno !== undefined && VOLUME_ERRNOS.has(errno)) {
    return { code: 'STORAGE_UNAVAILABLE', message: 'El disco ha dejado de responder durante la operación', fatal: true };
  }
  if (errno === 'ENOSPC') return { code: 'INSUFFICIENT_STORAGE', message: 'El disco está lleno', fatal: true };
  if (errno === 'EACCES' || errno === 'EPERM') return { code: 'FORBIDDEN', message: 'Sin permiso sobre este elemento', fatal: false };
  if (errno === 'ENOTEMPTY' || errno === 'EEXIST') return { code: 'CONFLICT', message: 'El destino cambió durante la operación', fatal: false };
  return { code: 'INTERNAL', message: 'Error interno', fatal: false };
}

function sameSegments(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, index) => foldKey(segment) === foldKey(b[index] as string));
}

function isInside(child: readonly string[], parent: readonly string[]): boolean {
  return child.length >= parent.length && parent.every((segment, index) => foldKey(segment) === foldKey(child[index] as string));
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return false;
    throw error;
  }
}

async function takenKeys(dir: string, atRoot = false): Promise<Set<string>> {
  const keys = new Set((await readdir(dir)).map(foldKey));
  // En la raíz, los nombres reservados cuentan como ocupados: un elemento llamado «.pcloud» que
  // se mueva o restaure allí se guarda como «.pcloud (2)», nunca dentro de la carpeta interna.
  if (atRoot) for (const reserved of ['.pcloud', 'System Volume Information', '$RECYCLE.BIN', '.Trashes', '.Spotlight-V100', '.fseventsd', '.TemporaryItems']) keys.add(foldKey(reserved));
  return keys;
}

async function writeDurable(file: string, content: string): Promise<void> {
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class FsOperations {
  readonly #o: FsOperationsOptions;
  readonly #clock: () => Date;

  constructor(options: FsOperationsOptions) {
    this.#o = options;
    this.#clock = options.clock ?? (() => new Date());
  }

  #trashDir(lease: VolumeLease): string {
    return path.join(lease.internalDir, 'trash');
  }

  #stagingDir(lease: VolumeLease): string {
    return path.join(lease.internalDir, 'staging');
  }

  /** Ejecuta `fn` por elemento. Un fallo de disco detiene el lote; el resto de fallos no. */
  async #batch(paths: readonly string[], fn: (clientPath: string) => Promise<{ path: string; name: string }>): Promise<ItemResult[]> {
    const results: ItemResult[] = [];
    let stop: { code: string; message: string } | null = null;
    for (const from of paths) {
      if (stop !== null) {
        results.push({ from, ok: false, code: stop.code, message: stop.message });
        continue;
      }
      try {
        const done = await fn(from);
        results.push({ from, ok: true, path: done.path, name: done.name });
      } catch (error) {
        const failure = failureOf(error);
        results.push({ from, ok: false, code: failure.code, message: failure.message });
        if (failure.fatal) stop = { code: failure.code, message: 'No se ha intentado: el disco dejó de estar disponible' };
      }
    }
    return results;
  }

  // ── Crear y renombrar ───────────────────────────────────────────────────────────────────

  /** Crea un archivo vacío. 409 si el nombre ya existe (sin distinguir mayúsculas). */
  createFile(parentPath: string, rawName: string): Promise<{ path: string; name: string }> {
    return this.#o.serial.run(async () => {
      const name = checkNewName(rawName);
      const segments = parseClientPath(parentPath);
      if (segments.length === 0 && isReservedTopName(name)) throw new AppError('INVALID_NAME', 'Nombre reservado del sistema');
      const lease = await this.#o.gate.assertWritableVolume();
      const parent = await resolveInside(lease.dataRoot, segments, 'dir');
      if ((await takenKeys(parent.abs)).has(foldKey(name))) throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
      await assertSpaceFor(lease.mountPoint, this.#o, 0);
      await this.#o.gate.revalidate(lease);
      let handle;
      try {
        handle = await open(path.join(parent.abs, name), 'wx', 0o600);
      } catch (error) {
        if (errnoOf(error) === 'EEXIST') throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
        throw error;
      }
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(parent.abs);
      return { path: formatClientPath([...segments, name]), name };
    });
  }

  /**
   * Renombra dentro de la misma carpeta. Admite cambiar solo mayúsculas o acentos (en exFAT eso es
   * el MISMO nombre para el sistema de archivos y un rename directo no haría nada): se hace en dos
   * pasos a través de staging, con un fichero de intención para completarlo tras un corte.
   */
  rename(clientPath: string, rawName: string): Promise<{ path: string; name: string }> {
    return this.#o.serial.run(async () => {
      const name = checkNewName(rawName);
      const segments = parseClientPath(clientPath);
      const oldName = segments.at(-1);
      if (oldName === undefined) throw new AppError('INVALID_PATH', 'No se puede renombrar la carpeta raíz');
      const parentSegments = segments.slice(0, -1);
      if (parentSegments.length === 0 && isReservedTopName(name)) throw new AppError('INVALID_NAME', 'Nombre reservado del sistema');
      const lease = await this.#o.gate.assertWritableVolume();
      const source = await resolveInside(lease.dataRoot, segments, 'any');
      const parentAbs = path.dirname(source.abs);
      const result = { path: formatClientPath([...parentSegments, name]), name };
      if (name === oldName) return result;

      const siblings = await readdir(parentAbs);
      if (siblings.some((sibling) => sibling !== oldName && foldKey(sibling) === foldKey(name))) {
        throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
      }
      const targetAbs = path.join(parentAbs, name);

      if (foldKey(name) === foldKey(oldName)) {
        await this.#renameInTwoSteps(lease, source.abs, [...parentSegments, name]);
        return result;
      }

      await this.#o.gate.revalidate(lease);
      if (await exists(targetAbs)) throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
      await rename(source.abs, targetAbs);
      await syncDirectory(parentAbs);
      return result;
    });
  }

  async #renameInTwoSteps(lease: VolumeLease, sourceAbs: string, target: string[]): Promise<void> {
    const staging = this.#stagingDir(lease);
    const id = randomUUID();
    const tmpName = `${id}${RENAMING_SUFFIX}`;
    const intentFile = path.join(staging, `${id}${RENAME_INTENT_SUFFIX}`);
    const intent: RenameIntent = { v: 1, tmp: tmpName, target };
    const parentAbs = path.dirname(sourceAbs);

    await this.#o.gate.revalidate(lease);
    await writeDurable(intentFile, JSON.stringify(intent));
    await syncDirectory(staging);
    await rename(sourceAbs, path.join(staging, tmpName));
    await syncDirectory(parentAbs);
    await syncDirectory(staging);
    try {
      await this.#o.gate.revalidate(lease);
      await rename(path.join(staging, tmpName), path.join(lease.dataRoot, ...target));
    } catch (error) {
      // Se devuelve a su sitio original en la misma operación (no queda oculto en staging).
      await rename(path.join(staging, tmpName), sourceAbs)
        .then(async () => {
          await syncDirectory(parentAbs);
          await unlink(intentFile);
          await syncDirectory(staging);
        })
        .catch(() => undefined); // si tampoco se puede, recover() lo completará al volver el disco
      throw error;
    }
    await syncDirectory(parentAbs);
    await syncDirectory(staging);
    await unlink(intentFile);
    await syncDirectory(staging);
  }

  /** Crea una carpeta (en la cola: nunca se cruza con un rename que compruebe el mismo nombre). */
  createFolder(parentPath: string, rawName: string): Promise<{ path: string; name: string }> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      return createFolderIn(lease.dataRoot, parentPath, rawName, () => this.#o.gate.revalidate(lease));
    });
  }

  // ── Mover y copiar ──────────────────────────────────────────────────────────────────────

  /** Mueve elementos a una carpeta del mismo volumen (rename atómico por elemento). */
  move(paths: readonly string[], destination: string): Promise<ItemResult[]> {
    return this.#o.serial.run(async () => {
      const destSegments = parseClientPath(destination);
      const lease = await this.#o.gate.assertWritableVolume();
      const dest = await resolveInside(lease.dataRoot, destSegments, 'dir');
      return this.#batch(paths, async (from) => {
        const segments = parseClientPath(from);
        const name = segments.at(-1);
        if (name === undefined) throw new AppError('INVALID_PATH', 'No se puede mover la carpeta raíz');
        const source = await resolveInside(lease.dataRoot, segments, 'any');
        if (sameSegments(segments.slice(0, -1), destSegments)) return { path: formatClientPath(segments), name };
        if (source.stats.isDirectory() && isInside(destSegments, segments)) {
          throw new AppError('INVALID_PATH', 'No se puede mover una carpeta dentro de sí misma');
        }
        const finalName = uniqueName(name, await takenKeys(dest.abs, destSegments.length === 0));
        const targetAbs = path.join(dest.abs, finalName);
        await this.#o.gate.revalidate(lease);
        if (await exists(targetAbs)) throw new AppError('CONFLICT', 'El destino cambió durante la operación');
        await rename(source.abs, targetAbs);
        await syncDirectory(dest.abs);
        await syncDirectory(path.dirname(source.abs));
        return { path: formatClientPath([...destSegments, finalName]), name: finalName };
      });
    });
  }

  /**
   * Copia elementos a una carpeta. Cada elemento se construye completo en staging (con fsync de
   * cada archivo y carpeta) y aparece en el destino con un único rename: nunca hay copias a medias
   * visibles. Si el nombre existe en el destino (o se copia en la misma carpeta) → «nombre (2)».
   */
  copy(paths: readonly string[], destination: string): Promise<ItemResult[]> {
    return this.#o.serial.run(async () => {
      const destSegments = parseClientPath(destination);
      const lease = await this.#o.gate.assertWritableVolume();
      const dest = await resolveInside(lease.dataRoot, destSegments, 'dir');
      return this.#batch(paths, async (from) => {
        const segments = parseClientPath(from);
        const name = segments.at(-1);
        if (name === undefined) throw new AppError('INVALID_PATH', 'No se puede copiar la carpeta raíz');
        const source = await resolveInside(lease.dataRoot, segments, 'any');
        if (source.stats.isDirectory() && isInside(destSegments, segments)) {
          throw new AppError('INVALID_PATH', 'No se puede copiar una carpeta dentro de sí misma');
        }

        // Inventario previo: límites, nombres portables, sin enlaces ni ficheros especiales, espacio.
        let entries = 0;
        let bytes = 0;
        for await (const entry of walkTree(source.abs, source.stats)) {
          entries += 1;
          if (entries > MAX_COPY_ENTRIES) {
            throw new AppError('PAYLOAD_TOO_LARGE', `Demasiados elementos para copiar de una vez (máximo ${MAX_COPY_ENTRIES})`);
          }
          const entryName = entry.rel === '' ? name : path.posix.basename(entry.rel);
          if (!entry.stats.isFile() && !entry.stats.isDirectory()) {
            throw new AppError('INVALID_PATH', `Contiene un enlace o elemento especial que no se puede copiar: ${entry.rel || name}`);
          }
          const issue = portabilityIssue(entryName);
          if (issue !== null) throw new AppError('INVALID_NAME', `«${entryName}»: ${issue}. Renómbralo antes de copiar.`);
          if (entry.stats.isFile()) bytes += entry.stats.size;
        }
        await assertSpaceFor(lease.mountPoint, this.#o, bytes);

        const staging = this.#stagingDir(lease);
        const work = path.join(staging, `${randomUUID()}${COPY_SUFFIX}`);
        try {
          await this.#copyTree(lease, source.abs, source.stats, work);
          const finalName = uniqueName(name, await takenKeys(dest.abs, destSegments.length === 0));
          const targetAbs = path.join(dest.abs, finalName);
          await this.#o.gate.revalidate(lease);
          if (await exists(targetAbs)) throw new AppError('CONFLICT', 'El destino cambió durante la operación');
          await rename(work, targetAbs);
          await syncDirectory(dest.abs);
          await syncDirectory(staging);
          return { path: formatClientPath([...destSegments, finalName]), name: finalName };
        } catch (error) {
          await this.#removeStagingTree(lease, work).catch(() => undefined);
          throw error;
        }
      });
    });
  }

  async #copyTree(lease: VolumeLease, sourceAbs: string, sourceStats: Stats, targetAbs: string): Promise<void> {
    if (sourceStats.isFile()) {
      await this.#copyFile(lease, sourceAbs, sourceStats, targetAbs);
      return;
    }
    await this.#o.gate.revalidate(lease);
    await mkdir(targetAbs, { mode: 0o700 });
    for (const name of await readdir(sourceAbs)) {
      const childAbs = path.join(sourceAbs, name);
      const childStats = await lstat(childAbs);
      if (!childStats.isFile() && !childStats.isDirectory()) {
        throw new AppError('CONFLICT', 'El contenido cambió durante la copia');
      }
      await this.#copyTree(lease, childAbs, childStats, path.join(targetAbs, name));
    }
    await utimes(targetAbs, sourceStats.atime, sourceStats.mtime).catch(() => undefined);
    await syncDirectory(targetAbs);
  }

  async #copyFile(lease: VolumeLease, sourceAbs: string, sourceStats: Stats, targetAbs: string): Promise<void> {
    await this.#o.gate.revalidate(lease);
    const input = await open(sourceAbs, 'r');
    try {
      const output = await open(targetAbs, 'wx', 0o600);
      try {
        const buffer = Buffer.allocUnsafe(COPY_BUFFER);
        let position = 0;
        for (;;) {
          const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          await output.write(buffer, 0, bytesRead, position);
          position += bytesRead;
        }
        if (position !== sourceStats.size) throw new AppError('CONFLICT', 'El archivo cambió durante la copia');
        await output.utimes(sourceStats.atime, sourceStats.mtime).catch(() => undefined);
        await output.sync();
      } finally {
        await output.close();
      }
    } finally {
      await input.close();
    }
  }

  /** Borra un árbol temporal propio. Solo actúa sobre nombres de copia dentro de staging. */
  async #removeStagingTree(lease: VolumeLease, target: string): Promise<void> {
    const staging = this.#stagingDir(lease);
    if (path.dirname(target) !== staging || !path.basename(target).endsWith(COPY_SUFFIX)) {
      throw new Error(`ruta temporal inesperada: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
    await syncDirectory(staging);
  }

  // ── Papelera ────────────────────────────────────────────────────────────────────────────

  /**
   * Envía elementos a la papelera: primero se escriben y sincronizan sus metadatos y después se
   * mueve el elemento con un rename atómico. Si el corte llega entre ambos pasos, el elemento
   * sigue en su sitio y `recover()` retira los metadatos huérfanos.
   */
  trash(paths: readonly string[], userId: number | null): Promise<ItemResult[]> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      const trashDir = this.#trashDir(lease);
      await this.#ensureDir(lease, trashDir);
      return this.#batch(paths, async (from) => {
        const segments = parseClientPath(from);
        const name = segments.at(-1);
        if (name === undefined) throw new AppError('INVALID_PATH', 'No se puede eliminar la carpeta raíz');
        const source = await resolveInside(lease.dataRoot, segments, 'any');
        let size = 0;
        if (source.stats.isDirectory()) {
          for await (const entry of walkTree(source.abs, source.stats)) if (entry.stats.isFile()) size += entry.stats.size;
        } else {
          size = source.stats.size;
        }
        const id = `${this.#clock().getTime().toString().padStart(13, '0')}-${randomBytes(4).toString('hex')}`;
        const entryDir = path.join(trashDir, id);
        const meta: TrashMeta = {
          v: 1,
          name,
          originalPath: formatClientPath(segments),
          type: source.stats.isDirectory() ? 'dir' : 'file',
          size,
          deletedAt: this.#clock().toISOString(),
          deletedBy: userId,
        };
        await this.#o.gate.revalidate(lease);
        await mkdir(entryDir, { mode: 0o700 });
        await writeDurable(path.join(entryDir, TRASH_META), JSON.stringify(meta));
        await syncDirectory(entryDir);
        await syncDirectory(trashDir);
        await this.#o.gate.revalidate(lease);
        await rename(source.abs, path.join(entryDir, TRASH_ITEM));
        await syncDirectory(path.dirname(source.abs));
        await syncDirectory(entryDir);
        return { path: `trash:${id}`, name };
      });
    });
  }

  async #ensureDir(lease: VolumeLease, dir: string): Promise<void> {
    if (await exists(dir)) return;
    await this.#o.gate.revalidate(lease);
    await mkdir(dir, { mode: 0o700 });
    await syncDirectory(path.dirname(dir));
  }

  async #readTrashEntry(trashDir: string, id: string): Promise<TrashEntry | null> {
    const entryDir = path.join(trashDir, id);
    let itemStats: Stats;
    try {
      itemStats = await lstat(path.join(entryDir, TRASH_ITEM));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null; // a medias: lo resuelve recover()
      throw error;
    }
    let meta: Partial<TrashMeta> = {};
    try {
      meta = JSON.parse(await readFile(path.join(entryDir, TRASH_META), 'utf8')) as Partial<TrashMeta>;
    } catch {
      // Metadatos ausentes o dañados: el elemento se muestra igualmente y se puede restaurar a la raíz.
    }
    const deletedMs = Number(id.slice(0, 13));
    const deletedAt = typeof meta.deletedAt === 'string' ? meta.deletedAt : new Date(deletedMs).toISOString();
    const retention = this.#o.trashRetentionDays;
    return {
      id,
      name: typeof meta.name === 'string' ? meta.name : `Recuperado ${id}`,
      originalPath: typeof meta.originalPath === 'string' ? meta.originalPath : null,
      type: itemStats.isDirectory() ? 'dir' : 'file',
      size: typeof meta.size === 'number' ? meta.size : itemStats.isFile() ? itemStats.size : 0,
      deletedAt,
      expiresAt: retention === null ? null : new Date(new Date(deletedAt).getTime() + retention * 86_400_000).toISOString(),
    };
  }

  async listTrash(): Promise<TrashListResponse> {
    const lease = await this.#o.gate.assertReadableVolume();
    const trashDir = this.#trashDir(lease);
    let ids: string[];
    try {
      ids = (await readdir(trashDir)).filter((name) => TRASH_ID.test(name));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') ids = [];
      else throw error;
    }
    const entries: TrashEntry[] = [];
    for (const id of ids) {
      const entry = await this.#readTrashEntry(trashDir, id);
      if (entry !== null) entries.push(entry);
    }
    entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { entries, totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0), retentionDays: this.#o.trashRetentionDays };
  }

  /**
   * Restaura en su ubicación original. Si la carpeta original ya no existe se vuelve a crear; si
   * en su lugar hay un archivo, se restaura en la raíz. Si el nombre está ocupado → «nombre (2)».
   */
  restore(ids: readonly string[]): Promise<ItemResult[]> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      const trashDir = this.#trashDir(lease);
      return this.#batch(ids, async (id) => {
        if (!TRASH_ID.test(id)) throw new AppError('NOT_FOUND', 'No está en la papelera');
        const entry = await this.#readTrashEntry(trashDir, id);
        if (entry === null) throw new AppError('NOT_FOUND', 'No está en la papelera');
        const entryDir = path.join(trashDir, id);

        let parentSegments: string[] = [];
        if (entry.originalPath !== null) {
          try {
            parentSegments = parseClientPath(entry.originalPath).slice(0, -1);
          } catch {
            parentSegments = [];
          }
        }
        const parent = await this.#ensureParents(lease, parentSegments);
        const finalName = uniqueName(entry.name, await takenKeys(parent.abs, parent.segments.length === 0));
        const targetAbs = path.join(parent.abs, finalName);
        await this.#o.gate.revalidate(lease);
        if (await exists(targetAbs)) throw new AppError('CONFLICT', 'El destino cambió durante la operación');
        await rename(path.join(entryDir, TRASH_ITEM), targetAbs);
        await syncDirectory(parent.abs);
        await syncDirectory(entryDir);
        await unlink(path.join(entryDir, TRASH_META)).catch((error: unknown) => {
          if (errnoOf(error) !== 'ENOENT') throw error;
        });
        await rmdir(entryDir);
        await syncDirectory(trashDir);
        return { path: formatClientPath([...parent.segments, finalName]), name: finalName };
      });
    });
  }

  /** Crea las carpetas que falten hasta `segments`. Si alguna es un archivo, devuelve la raíz. */
  async #ensureParents(lease: VolumeLease, segments: readonly string[]): Promise<{ abs: string; segments: string[] }> {
    let abs = lease.dataRoot;
    const done: string[] = [];
    for (const segment of segments) {
      const next = path.join(abs, segment);
      let stats: Stats | null = null;
      try {
        stats = await lstat(next);
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') throw error;
      }
      if (stats === null) {
        if (portabilityIssue(segment) !== null) return { abs: lease.dataRoot, segments: [] };
        await this.#o.gate.revalidate(lease);
        await mkdir(next, { mode: 0o700 });
        await syncDirectory(abs);
      } else if (!stats.isDirectory() || stats.isSymbolicLink()) {
        return { abs: lease.dataRoot, segments: [] };
      }
      abs = next;
      done.push(segment);
    }
    return { abs, segments: done };
  }

  /** Elimina DEFINITIVAMENTE elementos de la papelera. Es la única ruta de borrado real. */
  purge(ids: readonly string[]): Promise<number> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      return this.#purge(lease, ids);
    });
  }

  async #purge(lease: VolumeLease, ids: readonly string[]): Promise<number> {
    const trashDir = this.#trashDir(lease);
    let removed = 0;
    for (const id of ids) {
      if (!TRASH_ID.test(id)) continue;
      const entryDir = path.join(trashDir, id);
      let stats: Stats;
      try {
        stats = await lstat(entryDir);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') continue;
        throw error;
      }
      if (!stats.isDirectory()) continue;
      await this.#o.gate.revalidate(lease);
      // rm no sigue enlaces simbólicos: borra el enlace, nunca su destino.
      await rm(entryDir, { recursive: true, force: false });
      removed += 1;
    }
    if (removed > 0) await syncDirectory(trashDir);
    return removed;
  }

  emptyTrash(): Promise<number> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      const ids = await readdir(this.#trashDir(lease)).catch((error: unknown) => {
        if (errnoOf(error) === 'ENOENT') return [] as string[];
        throw error;
      });
      return this.#purge(lease, ids);
    });
  }

  /** Elimina lo que lleva en la papelera más que la retención configurada. Solo con disco escribible. */
  purgeExpired(): Promise<number> {
    const retention = this.#o.trashRetentionDays;
    if (retention === null) return Promise.resolve(0);
    return this.#o.serial.run(async () => {
      if (this.#o.clockTrusted !== undefined && !(await this.#o.clockTrusted())) return 0;
      const lease = await this.#o.gate.assertWritableVolume();
      const now = this.#clock().getTime();
      const limit = now - retention * 86_400_000;
      const ids = (await readdir(this.#trashDir(lease)).catch(() => [] as string[])).filter((id) => {
        if (!TRASH_ID.test(id)) return false;
        const deleted = Number(id.slice(0, 13));
        // Fechas «del futuro» (reloj atrasado al eliminar): nunca cuentan como caducadas.
        return deleted <= now && deleted < limit;
      });
      return this.#purge(lease, ids);
    });
  }

  // ── Recuperación tras un corte ──────────────────────────────────────────────────────────

  /**
   * Resuelve lo que quedó a medias. Nunca borra datos del usuario:
   *  - renombrado en dos pasos interrumpido → se completa (o se usa «nombre (2)» si el destino se ocupó);
   *  - copia interrumpida en staging → se descarta (el original no se tocó);
   *  - entrada de papelera sin elemento (el corte llegó antes del rename) → se retiran sus metadatos.
   */
  recover(): Promise<void> {
    return this.#o.serial.run(async () => {
      const lease = await this.#o.gate.assertWritableVolume();
      const staging = this.#stagingDir(lease);
      for (const name of await readdir(staging).catch(() => [] as string[])) {
        if (name.endsWith(RENAME_INTENT_SUFFIX)) {
          await this.#recoverRename(lease, path.join(staging, name)).catch(() => undefined);
        } else if (name.endsWith(COPY_SUFFIX)) {
          await this.#removeStagingTree(lease, path.join(staging, name)).catch(() => undefined);
        }
      }
      const trashDir = this.#trashDir(lease);
      for (const id of await readdir(trashDir).catch(() => [] as string[])) {
        if (!TRASH_ID.test(id)) continue;
        const entryDir = path.join(trashDir, id);
        if (await exists(path.join(entryDir, TRASH_ITEM))) continue;
        await this.#o.gate.revalidate(lease);
        await unlink(path.join(entryDir, TRASH_META)).catch(() => undefined);
        await rmdir(entryDir).catch(() => undefined);
        await syncDirectory(trashDir);
      }
    });
  }

  async #recoverRename(lease: VolumeLease, intentFile: string): Promise<void> {
    const staging = path.dirname(intentFile);
    const intent = JSON.parse(await readFile(intentFile, 'utf8')) as RenameIntent;
    if (intent.v !== 1 || !intent.tmp.endsWith(RENAMING_SUFFIX) || intent.tmp.includes('/') || intent.tmp.includes('\\')) {
      throw new Error('intención de renombrado no válida');
    }
    const tmpAbs = path.join(staging, intent.tmp);
    if (await exists(tmpAbs)) {
      const parent = await this.#ensureParents(lease, intent.target.slice(0, -1));
      const wanted = intent.target.at(-1) ?? 'Recuperado';
      const finalName = uniqueName(wanted, await takenKeys(parent.abs));
      await this.#o.gate.revalidate(lease);
      await rename(tmpAbs, path.join(parent.abs, finalName));
      await syncDirectory(parent.abs);
    }
    await unlink(intentFile);
    await syncDirectory(staging);
  }
}
