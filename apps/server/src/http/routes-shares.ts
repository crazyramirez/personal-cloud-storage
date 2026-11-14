/**
 * Enlaces para compartir (ADR-0018), lado del propietario: crear, listar, retirar y ver el
 * estado de la puerta de invitados. Lo que sirve los enlaces está en share/guest-app.ts.
 */

import { ShareCreateRequest, ShareParams, type GatewayView, type ShareCreateResponse, type ShareListResponse } from '@pcloud/contracts';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../auth/passwords.ts';
import { audit } from '../auth/sessions.ts';
import { AppError } from '../errors.ts';
import type { ShareGateway } from '../share/gateway.ts';
import { stateOf, viewOf, type ShareStore } from '../share/store.ts';
import { formatClientPath, parseClientPath, resolveInside } from '../storage/paths.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';
const RECHECK_MS = 15_000;
const NEEDS_ACTION = new Set(['needs_funnel', 'needs_https', 'no_tailscale', 'error']);

export function registerShareRoutes(app: FastifyInstance, ctx: RouteContext, store: ShareStore, gateway: ShareGateway): void {
  const { db, guardian, clock } = ctx;

  /** Estado de la puerta. Si espera algo de la persona (permitir Funnel…), se vuelve a mirar. */
  const gatewayView = (): GatewayView => {
    const view = gateway.view;
    const age = view.checkedAt === null ? Infinity : clock().getTime() - Date.parse(view.checkedAt);
    if (NEEDS_ACTION.has(view.state) && age > RECHECK_MS) void gateway.reconcile(true);
    return gateway.view;
  };

  app.get(`${API}/shares`, async (request): Promise<ShareListResponse> => {
    ctx.owner(request);
    const now = clock();
    const shares = store.list().map((share) => viewOf(share, now));
    // Activos primero; dentro de cada grupo, los más recientes.
    shares.sort((a, b) => Number(b.state === 'active') - Number(a.state === 'active') || b.createdAt.localeCompare(a.createdAt));
    return { shares, gateway: gatewayView() };
  });

  app.get(`${API}/shares/gateway`, async (request): Promise<GatewayView> => {
    ctx.owner(request);
    return gatewayView();
  });

  app.post(`${API}/shares/gateway/check`, async (request): Promise<GatewayView> => {
    ctx.owner(request);
    await gateway.reconcile(true);
    return gateway.view;
  });

  app.post(`${API}/shares`, { schema: { body: ShareCreateRequest } }, async (request, reply): Promise<ShareCreateResponse> => {
    const session = ctx.owner(request);
    const body = request.body as ShareCreateRequest;
    const segments = parseClientPath(body.path);
    if (segments.length === 0) throw new AppError('INVALID_PATH', 'No se puede compartir la nube entera: elige un archivo o una carpeta');
    const lease = await guardian.assertReadableVolume();
    const found = await resolveInside(lease.dataRoot, segments, 'any');
    // En una carpeta cada archivo sería una descarga: el límite solo tiene sentido en archivos.
    if (found.stats.isDirectory() && body.maxDownloads !== undefined) throw new AppError('VALIDATION_FAILED', 'El límite de descargas solo se puede poner a un archivo');
    const passwordHash = body.password === undefined || body.password === '' ? null : await hashPassword(body.password);
    const now = clock();
    const created = store.create(
      {
        path: formatClientPath(segments),
        kind: found.stats.isDirectory() ? 'dir' : 'file',
        name: segments.at(-1) as string,
        userId: session.userId,
        expiresInDays: body.expiresInDays,
        passwordHash,
        maxDownloads: body.maxDownloads ?? null,
      },
      now,
    );
    const detail = [`enlace ${created.share.id}`, `${body.expiresInDays} d`, passwordHash === null ? null : 'con contraseña', body.maxDownloads === undefined ? null : `máx. ${body.maxDownloads} descargas`]
      .filter((part) => part !== null)
      .join(' · ');
    audit(db, { userId: session.userId, action: 'share.create', path: created.share.path, result: 'ok', ip: request.ip, detail }, now);
    void gateway.reconcile();
    void reply.status(201);
    return { share: viewOf(created.share, now), token: created.token, gateway: gateway.view };
  });

  // Retirar: un enlace activo se revoca (deja de funcionar al instante); uno que ya no funciona se borra de la lista.
  app.delete(`${API}/shares/:id`, { schema: { params: ShareParams } }, async (request, reply) => {
    const session = ctx.owner(request);
    const { id } = request.params as ShareParams;
    const share = store.get(id);
    if (share === null) throw new AppError('NOT_FOUND', 'Ese enlace no existe');
    const now = clock();
    if (stateOf(share, now) === 'active') {
      store.revoke(id, now);
      audit(db, { userId: session.userId, action: 'share.revoke', path: share.path, result: 'ok', ip: request.ip, detail: `enlace ${id}` }, now);
      void gateway.reconcile();
    } else {
      store.remove(id);
    }
    return reply.status(204).send();
  });
}
