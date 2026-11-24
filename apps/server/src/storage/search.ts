/**
 * Búsqueda por nombre en una carpeta y todas sus subcarpetas (como el cuadro de búsqueda del
 * Explorador de Windows o del Finder).
 *
 * Con el índice de nombres (search-index.ts, ADR-0029) la búsqueda cubre todo el árbol al
 * instante; además se recorre en directo un momento la carpeta de la búsqueda (lo más cercano y lo
 * más reciente) y se suma lo creado desde la web después del último índice. El índice es solo una
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
export const LIVE_WITH_INDEX_MS = 1_500;
export const MAX_SEARCH_VISITED = 400_000;
export const DEFAULT_SEARCH_LIMIT = 300;
const STAT_CONCURRENCY = 16;
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

/** Lo que la búsqueda necesita del índice (SearchIndex lo cumple). */
export interface SearchIndexSource {
  readonly state: 'ready' | 'building' | 'none';
  readonly builtAt: string | null;
  readonly index: { find(segments: readonly string[], tokens: readonly string[]): string[][] | null } | null;
  /** Rutas creadas o cambiadas desde la web después del último índice. */
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
  const fromIndex = source?.index?.find(segments, tokens) ?? null;
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

  // 2) En directo: con índice, solo un momento (lo cercano y lo reciente); sin él, es la búsqueda.
  const deadline = now() + (fromIndex !== null ? Math.min(LIVE_WITH_INDEX_MS, options.budgetMs ?? SEARCH_TIME_BUDGET_MS) : (options.budgetMs ?? SEARCH_TIME_BUDGET_MS));
  const stopped = (): boolean => options.signal?.aborted === true || now() > deadline;
  const found: Array<{ abs: string; segments: string[] }> = [];
  const queue: Array<{ abs: string; segments: string[] }> = [{ abs: base.abs, segments }];
  let head = 0;
  let scanned = 0;
  let liveTruncated: FsSearchResponse['truncated'] = null;

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

  // 3) Comprobación en el disco: lo encontrado en directo (lstat) y lo del índice (por componentes,
  //    sin enlaces ni salir del volumen), hasta el máximo de resultados.
  const results: Array<FsSearchResult & { depth: number }> = [];
  const seen = new Set<string>();
  const live = new Array<FsSearchResult | null>(found.length);
  let next = 0;
  const liveWorker = async (): Promise<void> => {
    while (next < found.length) {
      const index = next++;
      const item = found[index] as { abs: string; segments: string[] };
      try {
        live[index] = resultOf(item.segments, await lstat(item.abs));
      } catch (error) {
        if (!SKIPPABLE.has(errnoOf(error) ?? '')) throw error;
        live[index] = null; // desapareció mientras se buscaba
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, found.length) }, liveWorker));
  found.forEach((item, index) => {
    seen.add(keyOf(item.segments));
    const result = live[index];
    if (result !== null && result !== undefined) results.push({ ...result, depth: item.segments.length });
  });

  const pending = candidates.filter((candidate) => {
    const key = keyOf(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  let cursor = 0;
  const indexWorker = async (): Promise<void> => {
    while (cursor < pending.length && results.length < limit && options.signal?.aborted !== true) {
      const candidate = pending[cursor++] as string[];
      try {
        const resolved = await resolveInside(dataRoot, candidate, 'any');
        const result = resultOf(candidate, resolved.stats);
        if (result !== null && results.length < limit) results.push({ ...result, depth: candidate.length });
      } catch (error) {
        // Ya no está (o dejó de ser válido): el índice era viejo. No se muestra.
        if (error instanceof AppError || SKIPPABLE.has(errnoOf(error) ?? '')) continue;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, pending.length) }, indexWorker));

  let truncated: FsSearchResponse['truncated'];
  if (results.length >= limit && (cursor < pending.length || liveTruncated === 'limit')) truncated = 'limit';
  else if (fromIndex !== null) truncated = null; // el índice cubre todo el árbol
  else truncated = liveTruncated;

  // Lo más cercano primero; dentro del mismo nivel, carpetas y luego por nombre.
  results.sort((a, b) => a.depth - b.depth || Number(b.type === 'dir') - Number(a.type === 'dir') || collator.compare(a.name, b.name));
  return response(results.map(({ depth: _depth, ...result }) => result), truncated, scanned);
}
