/**
 * Favoritos (ADR-0027): listar, añadir y quitar. Cada usuario tiene los suyos.
 *
 * La lista se sirve aunque el disco no se pueda leer (con `exists: null`): la barra lateral y el
 * Panel siguen mostrando los nombres, y nada se quita solo porque el disco no esté.
 */

import { FavoritePathsRequest, MAX_FAVORITES, type FavoriteEntry, type FavoriteListResponse } from '@pcloud/contracts';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';
import { FavoriteStore, type FavoriteRow } from '../favorites/store.ts';
import { formatClientPath, parseClientPath, resolveInside } from '../storage/paths.ts';
import { StorageUnavailableError } from '../storage/storage-guardian.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';
/** Comprobaciones en paralelo al listar (cada una son unos pocos lstat). */
const STAT_CONCURRENCY = 8;

const normalize = (p: string): string => formatClientPath(parseClientPath(p));

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

export function registerFavoriteRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, guardian, clock } = ctx;
  const store = new FavoriteStore(db);

  const listFor = async (userId: number): Promise<FavoriteListResponse> => {
    const rows = store.list(userId);
    let dataRoot: string | null = null;
    try {
      dataRoot = (await guardian.assertReadableVolume()).dataRoot;
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) throw error;
    }
    const entries = await mapLimit(rows, STAT_CONCURRENCY, async (row: FavoriteRow): Promise<FavoriteEntry> => {
      const segments = parseClientPath(row.path);
      const base: FavoriteEntry = {
        path: row.path,
        dir: formatClientPath(segments.slice(0, -1)),
        name: segments.at(-1) ?? '',
        type: row.kind,
        size: 0,
        mtime: null,
        addedAt: row.createdAt,
        exists: null,
      };
      if (dataRoot === null) return base;
      try {
        const found = await resolveInside(dataRoot, segments, 'any');
        const isDir = found.stats.isDirectory();
        return { ...base, type: isDir ? 'dir' : 'file', size: isDir ? 0 : found.stats.size, mtime: found.stats.mtime.toISOString(), exists: true };
      } catch (error) {
        // No está en esa ruta: se muestra como «no disponible». Un error de E/S no dice nada de
        // si existe: queda como desconocido.
        const gone = error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH');
        return { ...base, exists: gone ? false : null };
      }
    });
    return { entries, max: MAX_FAVORITES };
  };

  app.get(`${API}/favorites`, async (request): Promise<FavoriteListResponse> => listFor(ctx.user(request).userId));

  // Añadir: solo lo que existe ahora (así se sabe si es carpeta o archivo). Idempotente.
  app.post(`${API}/favorites`, { schema: { body: FavoritePathsRequest } }, async (request): Promise<FavoriteListResponse> => {
    const session = ctx.user(request);
    const paths = (request.body as FavoritePathsRequest).paths.map(parseClientPath);
    if (paths.some((segments) => segments.length === 0)) {
      throw new AppError('INVALID_PATH', 'La carpeta principal no se puede marcar como favorita: elige un archivo o una carpeta');
    }
    const lease = await guardian.assertReadableVolume();
    const items = [];
    for (const segments of paths) {
      const found = await resolveInside(lease.dataRoot, segments, 'any');
      items.push({ path: formatClientPath(segments), kind: found.stats.isDirectory() ? ('dir' as const) : ('file' as const) });
    }
    store.add(session.userId, items, clock());
    return listFor(session.userId);
  });

  // Orden personalizado (arrastrar en Favoritos): la lista en el orden nuevo. No necesita el disco.
  app.post(`${API}/favorites/order`, { schema: { body: FavoritePathsRequest } }, async (request): Promise<FavoriteListResponse> => {
    const session = ctx.user(request);
    store.reorder(session.userId, (request.body as FavoritePathsRequest).paths.map(normalize));
    return listFor(session.userId);
  });

  // Quitar: no necesita el disco (se puede quitar algo que ya no existe o con el disco desconectado).
  app.post(`${API}/favorites/remove`, { schema: { body: FavoritePathsRequest } }, async (request): Promise<FavoriteListResponse> => {
    const session = ctx.user(request);
    store.remove(session.userId, (request.body as FavoritePathsRequest).paths.map(normalize));
    return listFor(session.userId);
  });
}
