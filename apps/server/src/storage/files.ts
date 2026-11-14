/**
 * Operaciones del explorador sobre la raíz administrada: listado paginado bajo demanda (sin
 * índice previo, spec §6.1) y creación de carpetas. Quien llama aporta la raíz de datos de un
 * lease vigente del StorageGuardian; aquí no se decide si el volumen está disponible.
 */

import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FsEntry, FsListResponse } from '@pcloud/contracts';
import { AppError, errnoOf } from '../errors.ts';
import { syncDirectory } from '../fs/durability.ts';
import { checkNewName, foldKey, portabilityIssue } from './names.ts';
import { formatClientPath, isReservedTopName, parseClientPath, resolveInside } from './paths.ts';

export const DEFAULT_PAGE_SIZE = 200;
const STAT_CONCURRENCY = 16;
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface ListOptions {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * Lista una carpeta. Solo se hace `lstat` de la página pedida: una carpeta con 100 000
 * entradas no implica 100 000 consultas ni se envía de una vez (spec §9).
 */
export async function listDirectory(dataRoot: string, clientPath: string, options: ListOptions = {}): Promise<FsListResponse> {
  const segments = parseClientPath(clientPath);
  const dir = await resolveInside(dataRoot, segments, 'dir');
  const dirents = await readdir(dir.abs, { withFileTypes: true });

  // Solo carpetas y archivos regulares; enlaces, sockets y dispositivos no se exponen (spec §3.1).
  const visible = dirents.filter(
    (entry) => (entry.isDirectory() || entry.isFile()) && !(segments.length === 0 && isReservedTopName(entry.name)),
  );
  visible.sort((a, b) => {
    const kind = Number(b.isDirectory()) - Number(a.isDirectory());
    return kind !== 0 ? kind : collator.compare(a.name, b.name);
  });

  const keyCounts = new Map<string, number>();
  for (const entry of visible) {
    const key = foldKey(entry.name);
    keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  }

  const start = options.cursor === undefined ? 0 : Number(options.cursor);
  const limit = options.limit ?? DEFAULT_PAGE_SIZE;
  const page = visible.slice(start, start + limit);

  const entries = await mapLimit(page, STAT_CONCURRENCY, async (entry): Promise<FsEntry | null> => {
    let stats;
    try {
      stats = await lstat(path.join(dir.abs, entry.name));
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return null; // desapareció entre readdir y lstat
      throw error;
    }
    const isDir = stats.isDirectory();
    const issue =
      portabilityIssue(entry.name) ??
      ((keyCounts.get(foldKey(entry.name)) ?? 0) > 1 ? 'Coincide con otro nombre salvo por mayúsculas o acentos' : null);
    const base: FsEntry = {
      name: entry.name,
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : stats.size,
      mtime: stats.mtime.toISOString(),
      portable: issue === null,
    };
    return issue === null ? base : { ...base, issue };
  });

  const end = start + page.length;
  return {
    path: formatClientPath(segments),
    entries: entries.filter((entry): entry is FsEntry => entry !== null),
    total: visible.length,
    nextCursor: end < visible.length ? String(end) : null,
  };
}

/**
 * Crea una carpeta con nombre portable. `revalidate` es la revalidación del lease, que se
 * ejecuta justo antes de escribir (spec §3.4.5).
 */
export async function createFolder(
  dataRoot: string,
  parentPath: string,
  rawName: string,
  revalidate: () => Promise<void>,
): Promise<{ path: string; name: string }> {
  const name = checkNewName(rawName);
  const segments = parseClientPath(parentPath);
  if (segments.length === 0 && isReservedTopName(name)) throw new AppError('INVALID_NAME', 'Nombre reservado del sistema');
  const parent = await resolveInside(dataRoot, segments, 'dir');
  const siblings = await readdir(parent.abs);
  const key = foldKey(name);
  if (siblings.some((sibling) => foldKey(sibling) === key)) {
    throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
  }
  await revalidate();
  try {
    await mkdir(path.join(parent.abs, name), { mode: 0o700 });
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') throw new AppError('CONFLICT', 'Ya existe un elemento con ese nombre');
    throw error;
  }
  await syncDirectory(parent.abs);
  return { path: formatClientPath([...segments, name]), name };
}

export interface DownloadTarget {
  readonly abs: string;
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export async function resolveDownload(dataRoot: string, clientPath: string): Promise<DownloadTarget> {
  const segments = parseClientPath(clientPath);
  const name = segments.at(-1);
  if (name === undefined) throw new AppError('NOT_FOUND', 'No es un archivo');
  const file = await resolveInside(dataRoot, segments, 'file');
  return { abs: file.abs, name, size: file.stats.size, mtimeMs: file.stats.mtimeMs };
}
