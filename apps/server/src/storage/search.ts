/**
 * Búsqueda por nombre en una carpeta y todas sus subcarpetas (como el cuadro de búsqueda del
 * Explorador de Windows o del Finder). Sin índice previo (spec §6.1): recorre el árbol bajo
 * demanda, por niveles (lo más cercano aparece antes), solo leyendo y sin seguir enlaces
 * simbólicos. Solo se hace `lstat` de lo que coincide: en un disco USB lento, recorrer miles de
 * carpetas es leer directorios, no consultar cada archivo.
 *
 * Una carpeta enorme no debe bloquear al servidor: se corta por tiempo, por elementos recorridos,
 * al llegar al máximo de resultados o si quien buscaba se va (sigue escribiendo, cambia de
 * carpeta), y entonces lo dice (`truncated`).
 */

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FsSearchResponse, FsSearchResult } from '@pcloud/contracts';
import { errnoOf } from '../errors.ts';
import { formatClientPath, isReservedTopName, parseClientPath, resolveInside } from './paths.ts';

export const SEARCH_TIME_BUDGET_MS = 8_000;
export const MAX_SEARCH_VISITED = 400_000;
export const DEFAULT_SEARCH_LIMIT = 300;
const STAT_CONCURRENCY = 16;
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

export interface SearchOptions {
  readonly limit?: number | undefined;
  readonly budgetMs?: number;
  readonly maxVisited?: number;
  /** Se cancela si el navegador abandona la petición. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/** Sin mayúsculas ni acentos: «Canción» encuentra «cancion» y al revés. */
export const foldForSearch = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').normalize('NFC').toLowerCase();

/** Palabras de la búsqueda: el nombre debe contenerlas todas, en cualquier orden. */
export function searchTokens(query: string): string[] {
  return foldForSearch(query).split(/\s+/).filter((token) => token !== '');
}

/** Errores de una carpeta concreta que no impiden seguir buscando en las demás. */
const SKIPPABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

export async function searchTree(dataRoot: string, clientPath: string, query: string, options: SearchOptions = {}): Promise<FsSearchResponse> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? SEARCH_TIME_BUDGET_MS);
  const maxVisited = options.maxVisited ?? MAX_SEARCH_VISITED;
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const segments = parseClientPath(clientPath);
  const base = await resolveInside(dataRoot, segments, 'dir');
  const tokens = searchTokens(query);
  const response = (results: FsSearchResult[], truncated: FsSearchResponse['truncated'], scanned: number): FsSearchResponse => ({
    path: formatClientPath(segments),
    results,
    truncated,
    scanned,
  });
  if (tokens.length === 0) return response([], null, 0);
  const stopped = (): boolean => options.signal?.aborted === true || now() > deadline;

  const found: Array<{ abs: string; segments: string[] }> = [];
  const queue: Array<{ abs: string; segments: string[] }> = [{ abs: base.abs, segments }];
  let head = 0;
  let scanned = 0;
  let truncated: FsSearchResponse['truncated'] = null;

  walk: while (head < queue.length) {
    if (stopped() || scanned >= maxVisited) {
      truncated = 'time';
      break;
    }
    const dir = queue[head++] as { abs: string; segments: string[] };
    let dirents;
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true });
    } catch (error) {
      if (SKIPPABLE.has(errnoOf(error) ?? '')) continue; // desapareció o no se puede leer: se sigue
      throw error; // E/S del disco: lo traduce la capa HTTP (503)
    }
    // Dentro de cada carpeta, como en el listado: carpetas primero y por nombre.
    dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || collator.compare(a.name, b.name));
    for (const dirent of dirents) {
      scanned += 1;
      // Solo carpetas y archivos regulares; enlaces y especiales no existen para la web (spec §3.1).
      if (!dirent.isDirectory() && !dirent.isFile()) continue;
      if (dir.segments.length === 0 && isReservedTopName(dirent.name)) continue;
      const child = { abs: path.join(dir.abs, dirent.name), segments: [...dir.segments, dirent.name] };
      const name = foldForSearch(dirent.name);
      if (tokens.every((token) => name.includes(token))) {
        if (found.length >= limit) {
          truncated = 'limit';
          break walk;
        }
        found.push(child);
      }
      if (dirent.isDirectory()) queue.push(child);
      if ((scanned & 0xff) === 0 && stopped()) {
        truncated = 'time';
        break walk;
      }
    }
  }

  // Tamaño y fecha solo de lo encontrado.
  const results = new Array<FsSearchResult | null>(found.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < found.length) {
      const index = next++;
      const item = found[index] as { abs: string; segments: string[] };
      try {
        const stats = await lstat(item.abs);
        const isDir = stats.isDirectory();
        if (!isDir && !stats.isFile()) {
          results[index] = null;
          continue;
        }
        results[index] = {
          path: formatClientPath(item.segments),
          dir: formatClientPath(item.segments.slice(0, -1)),
          name: item.segments.at(-1) as string,
          type: isDir ? 'dir' : 'file',
          size: isDir ? 0 : stats.size,
          mtime: stats.mtime.toISOString(),
        };
      } catch (error) {
        if (!SKIPPABLE.has(errnoOf(error) ?? '')) throw error;
        results[index] = null; // desapareció mientras se buscaba
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, found.length) }, worker));
  return response(results.filter((item): item is FsSearchResult => item !== null), truncated, scanned);
}
