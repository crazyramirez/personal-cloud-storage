/**
 * Rutas de operaciones sobre archivos y carpetas, papelera y descargas ZIP.
 */

import { Readable } from 'node:stream';
import {
  BatchResponse,
  CreateFileRequest,
  RenameRequest,
  TransferItemsRequest,
  TrashIdsRequest,
  TrashItemsRequest,
  ZipQuery,
  RecentQuery,
  type DiskSpeedResponse,
  type RecentResponse,
  type ItemResult,
  type TrashListResponse,
  type TrashPurgeResponse,
} from '@pcloud/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit } from '../auth/sessions.ts';
import { AppError } from '../errors.ts';
import { SMB_RECENT_KEEP, SmbRecentStore, smbRecentGroup } from '../smb/recent.ts';
import { measureDiskSpeed } from '../storage/speedtest.ts';
import { formatClientPath, parseClientPath, resolveInside } from '../storage/paths.ts';
import { planZip, streamZip } from '../storage/zip.ts';
import { contentDisposition, type RouteContext } from './context.ts';

const API = '/api/v1';

export function registerFileRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, guardian, operations, clock } = ctx;

  /** Rechaza tocar una carpeta del sistema (la de la carpeta de red: borrarla se llevaría las copias). */
  const guardSystemFolders = async (paths: readonly string[]): Promise<void> => {
    const system = (await ctx.systemFolders()).map((p) => formatClientPath(parseClientPath(p)).toLowerCase());
    if (system.length === 0) return;
    for (const p of paths) {
      const normalized = formatClientPath(parseClientPath(p)).toLowerCase();
      const hit = system.find((s) => s === normalized);
      if (hit !== undefined) {
        throw new AppError(
          'CONFLICT',
          `La carpeta «${hit.slice(1)}» guarda las copias de tus ordenadores: no se puede borrar, mover ni renombrar mientras la carpeta de red esté activa`,
        );
      }
    }
  };

  const logBatch = (request: FastifyRequest, userId: number, action: string, results: ItemResult[], target?: string): void => {
    for (const result of results.slice(0, 200)) {
      audit(
        db,
        {
          userId,
          action,
          path: result.from,
          result: result.ok ? 'ok' : 'error',
          ip: request.ip,
          // Los identificadores internos de la papelera no aportan nada en la actividad.
          detail: result.ok ? (target === undefined ? undefined : `→ ${result.path}`) : `${result.code}: ${result.message}`,
        },
        clock(),
      );
    }
    if (results.length > 200) audit(db, { userId, action, result: 'ok', ip: request.ip, detail: `${results.length} elementos en total` }, clock());
  };

  app.post(`${API}/fs/files`, { schema: { body: CreateFileRequest } }, async (request, reply) => {
    const session = ctx.user(request);
    const body = request.body as CreateFileRequest;
    const created = await operations.createFile(body.path, body.name);
    audit(db, { userId: session.userId, action: 'fs.create', path: created.path, result: 'ok', ip: request.ip }, clock());
    void reply.status(201);
    return created;
  });

  app.post(`${API}/fs/rename`, { schema: { body: RenameRequest } }, async (request) => {
    const session = ctx.user(request);
    const body = request.body as RenameRequest;
    await guardSystemFolders([body.path]);
    const renamed = await operations.rename(body.path, body.name);
    audit(db, { userId: session.userId, action: 'fs.rename', path: body.path, result: 'ok', ip: request.ip, detail: `→ ${renamed.path}` }, clock());
    return renamed;
  });

  app.post(`${API}/fs/move`, { schema: { body: TransferItemsRequest } }, async (request): Promise<BatchResponse> => {
    const session = ctx.user(request);
    const body = request.body as TransferItemsRequest;
    await guardSystemFolders(body.paths);
    const results = await operations.move(body.paths, body.destination);
    logBatch(request, session.userId, 'fs.move', results, body.destination);
    return { results };
  });

  app.post(`${API}/fs/copy`, { schema: { body: TransferItemsRequest } }, async (request): Promise<BatchResponse> => {
    const session = ctx.user(request);
    const body = request.body as TransferItemsRequest;
    const results = await operations.copy(body.paths, body.destination);
    logBatch(request, session.userId, 'fs.copy', results, body.destination);
    return { results };
  });

  app.post(`${API}/fs/trash`, { schema: { body: TrashItemsRequest } }, async (request): Promise<BatchResponse> => {
    const session = ctx.user(request);
    const body = request.body as TrashItemsRequest;
    await guardSystemFolders(body.paths);
    const results = await operations.trash(body.paths, session.userId);
    logBatch(request, session.userId, 'fs.trash', results);
    return { results };
  });

  app.get(`${API}/fs/zip`, { schema: { querystring: ZipQuery } }, async (request, reply) => {
    const session = ctx.user(request);
    const query = request.query as ZipQuery;
    const lease = await guardian.assertReadableVolume();
    const names = query.names === undefined || query.names === '' ? null : query.names.split('/');
    const plan = await planZip(lease.dataRoot, query.dir, names, clock());
    audit(db, { userId: session.userId, action: 'fs.zip', path: query.dir, result: 'ok', ip: request.ip, detail: `${plan.entries.length} elementos` }, clock());
    const stream = Readable.from(streamZip(plan));
    stream.on('error', (error) => request.log.warn({ err: error }, 'descarga ZIP interrumpida'));
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', plan.length)
      .header('content-disposition', contentDisposition(plan.fileName))
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('cache-control', 'no-store')
      .send(stream);
  });

  // ── Recientes (Panel) ───────────────────────────────────────────────────────────────────────
  // A partir del registro de actividad (subidas, carpetas y archivos creados) y de lo que los
  // ordenadores escriben por la carpeta de red (smb_recent, ADR-0024), lo más nuevo primero y solo
  // lo que SIGUE existiendo en esa ruta: lo eliminado, movido o renombrado no aparece. Lo de la
  // carpeta de red se agrupa en la carpeta copiada y se omite lo oculto (ADR-0025).
  app.get(`${API}/fs/recent`, { schema: { querystring: RecentQuery } }, async (request): Promise<RecentResponse> => {
    ctx.user(request);
    const limit = (request.query as RecentQuery).limit ?? 12;
    const lease = await guardian.assertReadableVolume();
    const fromWeb = db
      .prepare("SELECT path, at FROM audit_log WHERE result = 'ok' AND path IS NOT NULL AND action IN ('fs.upload', 'fs.mkdir', 'fs.create') ORDER BY id DESC LIMIT 400")
      .all()
      .map((row) => ({ path: String(row['path']), at: String(row['at']) }));
    const fromSmb = new SmbRecentStore(db)
      .list(SMB_RECENT_KEEP)
      .flatMap((row) => {
        const group = smbRecentGroup(row.path);
        return group === null ? [] : [{ path: group, at: row.at }];
      });
    const rows = [...fromWeb, ...fromSmb].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const seen = new Set<string>();
    const entries: RecentResponse['entries'] = [];
    for (const row of rows) {
      if (entries.length >= limit) break;
      const clientPath = row.path;
      if (seen.has(clientPath)) continue;
      seen.add(clientPath);
      try {
        const segments = parseClientPath(clientPath);
        const name = segments.at(-1);
        if (name === undefined) continue;
        const found = await resolveInside(lease.dataRoot, segments, 'any');
        entries.push({
          path: formatClientPath(segments),
          dir: formatClientPath(segments.slice(0, -1)),
          name,
          type: found.stats.isDirectory() ? 'dir' : 'file',
          size: found.stats.isDirectory() ? 0 : found.stats.size,
          mtime: found.stats.mtime.toISOString(),
          at: row.at,
        });
      } catch {
        // Ya no existe (o la ruta dejó de ser válida): no se muestra.
      }
    }
    return { entries };
  });

  // ── Velocidad del disco (propietario) ─────────────────────────────────────────────────────

  app.post(`${API}/system/disk-speed`, async (request): Promise<DiskSpeedResponse> => {
    const session = ctx.owner(request);
    const result = await measureDiskSpeed(guardian, ctx.media.fio, ctx.config.storage, clock);
    audit(db, { userId: session.userId, action: 'system.diskspeed', result: 'ok', ip: request.ip, detail: `escritura ${result.writeMBps} MB/s · lectura ${result.readMBps} MB/s · ${result.randomReadIops} IOPS` }, clock());
    return result;
  });

  // ── Papelera ──────────────────────────────────────────────────────────────────────────────

  app.get(`${API}/trash`, async (request): Promise<TrashListResponse> => {
    ctx.user(request);
    return operations.listTrash();
  });

  app.post(`${API}/trash/restore`, { schema: { body: TrashIdsRequest } }, async (request): Promise<BatchResponse> => {
    const session = ctx.user(request);
    const body = request.body as TrashIdsRequest;
    const results = await operations.restore(body.ids);
    logBatch(request, session.userId, 'trash.restore', results);
    return { results };
  });

  // Borrado definitivo: solo el propietario.
  app.post(`${API}/trash/delete`, { schema: { body: TrashIdsRequest } }, async (request): Promise<TrashPurgeResponse> => {
    const session = ctx.owner(request);
    const body = request.body as TrashIdsRequest;
    const removed = await operations.purge(body.ids);
    audit(db, { userId: session.userId, action: 'trash.delete', result: 'ok', ip: request.ip, detail: `${removed} elementos eliminados definitivamente` }, clock());
    return { removed };
  });

  app.post(`${API}/trash/empty`, async (request): Promise<TrashPurgeResponse> => {
    const session = ctx.owner(request);
    const removed = await operations.emptyTrash();
    audit(db, { userId: session.userId, action: 'trash.empty', result: 'ok', ip: request.ip, detail: `${removed} elementos eliminados definitivamente` }, clock());
    return { removed };
  });

}
