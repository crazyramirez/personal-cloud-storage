/**
 * Búsqueda por nombre en una carpeta y todas sus subcarpetas (como el cuadro de búsqueda del
 * Explorador de Windows o del Finder).
 *
 * Con el índice de nombres (search-index.ts, ADR-0029) la búsqueda cubre todo el árbol al
 * instante; además se recorre en directo un momento la carpeta de la búsqueda (lo más cercano y lo
 * más reciente, a la vez que se comprueba lo del índice) y se suma lo creado desde la web después del último índice. El índice es solo una
 * pista: cada resultado se comprueba en el disco (sin enlaces, sin salir del volumen) antes de
 * devolverlo, así que nunca aparece algo que ya no existe.
 *
 * Sin índice (aún generándose), el recorrido en directo es la búsqueda: por niveles (lo más
 * cercano antes), solo leyendo, sin seguir enlaces simbólicos y haciendo `lstat` solo de lo que
 * coincide. Se corta por tiempo, por elementos recorridos, al llegar al máximo de resultados o si
 * quien buscaba se va, y entonces lo dice (`truncated`).
 */

import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FsSearchResponse, FsSearchResult } from '@pcloud/contracts';
import { AppError, errnoOf } from '../errors.ts';
import { formatClientPath, isReservedTopName, parseClientPath, resolveInside } from './paths.ts';

export const SEARCH_TIME_BUDGET_MS = 8_000;
/** Recorrido en directo cuando hay índice: solo lo cercano y lo reciente. */
export const LIVE_WITH_INDEX_MS = 400;
export const MAX_SEARCH_VISITED = 400_000;
export const DEFAULT_SEARCH_LIMIT = 300;
const STAT_CONCURRENCY = 16;
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Lo que la búsqueda necesita del índice (SearchIndex lo cumple). */
export interface SearchIndexSource {
  readonly state: 'ready' | 'building' | 'none';
  readonly builtAt: string | null;
  /** Coincidencias dentro de la carpeta; null = sin índice o la carpeta no está en él. */
  find(segments: readonly string[], tokens: readonly string[]): string[][] | null;
  /** Rutas creadas o cambiadas después del último índice. */
  readonly added: ReadonlySet<string>;
}

export interface SearchOptions {
  readonly limit?: number | undefined;
  readonly budgetMs?: number;
  readonly maxVisited?: number;
  /** Se cancela si el navegador abandona la petición. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly index?: SearchIndexSource | undefined;
}

/** Sin mayúsculas ni acentos: «Canción» encuentra «cancion» y al revés. */
export const foldForSearch = (text: string): string => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').normalize('NFC').toLowerCase();

/** Palabras de la búsqueda: el nombre debe contenerlas todas, en cualquier orden. */
export function searchTokens(query: string): string[] {
  return foldForSearch(query).split(/\s+/).filter((token) => token !== '');
}

/** Errores de una carpeta concreta que no impiden seguir buscando en las demás. */
const SKIPPABLE = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

const keyOf = (segments: readonly string[]): string => segments.join('/');

function resultOf(segments: readonly string[], stats: { isDirectory(): boolean; isFile(): boolean; size: number; mtime: Date }): FsSearchResult | null {
  const isDir = stats.isDirectory();
  if (!isDir && !stats.isFile()) return null;
  return {
    path: formatClientPath(segments),
    dir: formatClientPath(segments.slice(0, -1)),
    name: segments.at(-1) as string,
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : stats.size,
    mtime: stats.mtime.toISOString(),
  };
}

export async function searchTree(dataRoot: string, clientPath: string, query: string, options: SearchOptions = {}): Promise<FsSearchResponse> {
  const now = options.now ?? Date.now;
  const maxVisited = options.maxVisited ?? MAX_SEARCH_VISITED;
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  const segments = parseClientPath(clientPath);
  const base = await resolveInside(dataRoot, segments, 'dir');
  const tokens = searchTokens(query);
  const source = options.index;
  const indexInfo: FsSearchResponse['index'] = { state: source?.state ?? 'none', builtAt: source?.builtAt ?? null };
  const response = (results: FsSearchResult[], truncated: FsSearchResponse['truncated'], scanned: number): FsSearchResponse => ({
    path: formatClientPath(segments),
    results,
    truncated,
    scanned,
    index: indexInfo,
  });
  if (tokens.length === 0) return response([], null, 0);

  // 1) Índice: todas las coincidencias dentro de la carpeta (null = la carpeta no está en él).
  const fromIndex = source?.find(segments, tokens) ?? null;
  const candidates: string[][] = fromIndex ?? [];
  // Lo creado desde la web después del índice, si cae dentro y coincide.
  if (source !== undefined) {
    const prefix = keyOf(segments);
    for (const added of source.added) {
      const addedSegments = parseClientPath(added);
      const key = keyOf(addedSegments);
      const name = foldForSearch(addedSegments.at(-1) ?? '');
      const inside = prefix === '' ? addedSegments.length > 0 : key.startsWith(`${prefix}/`);
      if (inside && tokens.every((token) => name.includes(token))) candidates.push(addedSegments);
    }
  }

  // 2) En directo (con índice, solo un momento: lo cercano y lo reciente; sin él, es la búsqueda)
  //    y, a la vez, comprobación en el disco de lo que dice el índice.
  const deadline = now() + (fromIndex !== null ? Math.min(LIVE_WITH_INDEX_MS, options.budgetMs ?? SEARCH_TIME_BUDGET_MS) : (options.budgetMs ?? SEARCH_TIME_BUDGET_MS));
  const stopped = (): boolean => options.signal?.aborted === true || now() > deadline;
  let scanned = 0;
  let liveTruncated: FsSearchResponse['truncated'] = null;

  const liveSearch = async (): Promise<Array<FsSearchResult & { depth: number }>> => {
    const found: Array<{ abs: string; segments: string[] }> = [];
    const queue: Array<{ abs: string; segments: string[] }> = [{ abs: base.abs, segments }];
    let head = 0;
    walk: while (head < queue.length) {
      if (stopped() || scanned >= maxVisited) {
        liveTruncated = 'time';
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
            liveTruncated = 'limit';
            break walk;
          }
          found.push(child);
        }
        if (dirent.isDirectory()) queue.push(child);
        if ((scanned & 0xff) === 0 && stopped()) {
          liveTruncated = 'time';
          break walk;
        }
      }
    }
    // Tamaño y fecha solo de lo encontrado.
    const live = new Array<(FsSearchResult & { depth: number }) | null>(found.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < found.length) {
        const index = next++;
        const item = found[index] as { abs: string; segments: string[] };
        try {
          const result = resultOf(item.segments, await lstat(item.abs));
          live[index] = result === null ? null : { ...result, depth: item.segments.length };
        } catch (error) {
          if (!SKIPPABLE.has(errnoOf(error) ?? '')) throw error;
          live[index] = null; // desapareció mientras se buscaba
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, found.length) }, worker));
    return live.filter((item): item is FsSearchResult & { depth: number } => item !== null);
  };

  // Lo del índice se comprueba por componentes (sin enlaces ni salir del volumen): lo que ya no está
  // no se muestra. Como mucho «limit» válidos.
  const unique = new Set<string>();
  const pending = candidates.filter((candidate) => {
    const key = keyOf(candidate);
    if (unique.has(key)) return false;
    unique.add(key);
    return true;
  });
  let cursor = 0;
  const indexSearch = async (): Promise<Array<FsSearchResult & { depth: number }>> => {
    const valid: Array<FsSearchResult & { depth: number }> = [];
    const worker = async (): Promise<void> => {
      while (cursor < pending.length && valid.length < limit && options.signal?.aborted !== true) {
        const candidate = pending[cursor++] as string[];
        try {
          const resolved = await resolveInside(dataRoot, candidate, 'any');
          const result = resultOf(candidate, resolved.stats);
          if (result !== null) valid.push({ ...result, depth: candidate.length });
        } catch (error) {
          // Ya no está (o dejó de ser válido): el índice era viejo. No se muestra.
          if (error instanceof AppError || SKIPPABLE.has(errnoOf(error) ?? '')) continue;
          throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, pending.length) }, worker));
    return valid;
  };

  const [fromLive, fromDisk] = await Promise.all([liveSearch(), indexSearch()]);
  const merged = new Map<string, FsSearchResult & { depth: number }>();
  for (const item of [...fromLive, ...fromDisk]) if (!merged.has(item.path)) merged.set(item.path, item);
  // Lo más cercano primero; dentro del mismo nivel, carpetas y luego por nombre.
  const results = [...merged.values()].sort(
    (a, b) => a.depth - b.depth || Number(b.type === 'dir') - Number(a.type === 'dir') || collator.compare(a.name, b.name),
  );

  let truncated: FsSearchResponse['truncated'];
  if (results.length > limit || (results.length >= limit && (cursor < pending.length || liveTruncated === 'limit'))) truncated = 'limit';
  else if (fromIndex !== null) truncated = null; // el índice cubre todo el árbol
  else truncated = liveTruncated;

  return response(results.slice(0, limit).map(({ depth: _depth, ...result }) => result), truncated, scanned);
}
