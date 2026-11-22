/**
 * Tamaño de carpetas para el panel de detalles: recorre el árbol bajo demanda (sin índice previo,
 * spec §6.1), sin seguir enlaces simbólicos y solo leyendo (readdir + lstat). Una carpeta enorme
 * en un disco USB lento no debe bloquear al servidor: el recorrido se corta por tiempo, por número
 * de elementos o si quien lo pidió se va, y entonces devuelve lo contado como mínimo.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FsSizeResponse } from '@pcloud/contracts';
import { walkTree } from './operations.ts';
import { isReservedTopName, parseClientPath, resolveInside } from './paths.ts';

export const SIZE_TIME_BUDGET_MS = 15_000;
export const MAX_SIZE_ENTRIES = 1_000_000;

export interface SizeOptions {
  /** Milisegundos antes de cortar y devolver un total parcial. */
  readonly budgetMs?: number;
  readonly maxEntries?: number;
  /** Se cancela si el navegador abandona la petición. */
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/**
 * Rutas reales que hay que recorrer. Se resuelven todas antes de contar (una ruta no válida es un
 * error, no un total a medias); las repetidas o contenidas en otra pedida se quitan para no contar
 * dos veces, y la raíz se sustituye por su contenido sin las carpetas reservadas (.pcloud…).
 */
async function rootsOf(dataRoot: string, clientPaths: readonly string[]): Promise<string[]> {
  const keyed = new Map<string, string[]>();
  for (const clientPath of clientPaths) {
    const segments = parseClientPath(clientPath); // rechaza también las reservadas
    keyed.set(segments.join('/'), segments);
  }
  const keys = [...keyed.keys()];
  const roots: string[] = [];
  for (const [key, segments] of keyed) {
    if (keys.some((other) => other !== key && (other === '' || key.startsWith(`${other}/`)))) continue;
    const resolved = await resolveInside(dataRoot, segments, 'any');
    if (segments.length > 0) {
      roots.push(resolved.abs);
      continue;
    }
    for (const name of await readdir(resolved.abs)) {
      if (!isReservedTopName(name)) roots.push(path.join(resolved.abs, name));
    }
  }
  return roots;
}

export async function measureSize(dataRoot: string, clientPaths: readonly string[], options: SizeOptions = {}): Promise<FsSizeResponse> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? SIZE_TIME_BUDGET_MS);
  const maxEntries = options.maxEntries ?? MAX_SIZE_ENTRIES;
  const roots = await rootsOf(dataRoot, clientPaths);
  const pickedRoot = clientPaths.some((p) => parseClientPath(p).length === 0);

  let bytes = 0;
  let files = 0;
  let folders = 0;
  let seen = 0;
  for (const root of roots) {
    for await (const item of walkTree(root)) {
      if (options.signal?.aborted === true || now() > deadline || seen >= maxEntries) {
        return { bytes, files, folders, complete: false };
      }
      seen += 1;
      if (item.stats.isFile()) {
        files += 1;
        bytes += item.stats.size;
      } else if (item.stats.isDirectory() && (item.rel !== '' || pickedRoot)) {
        // Las carpetas pedidas no cuentan como subcarpetas; las de primer nivel de la raíz, sí.
        folders += 1;
      }
    }
  }
  return { bytes, files, folders, complete: true };
}
