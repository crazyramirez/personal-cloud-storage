/**
 * Emparejar un ordenador con la carpeta de red (ADR-0022).
 *
 *   GET    /pairing        propietario: ¿está la carpeta de red? ¿hay un código vigente?
 *   POST   /pairing/code   propietario: código nuevo de 6 cifras (10 min, un solo uso)
 *   DELETE /pairing/code   propietario: anula el código vigente
 *   POST   /pairing/claim  público (lo llama DEV Backup Studio): código → credenciales
 */

import { PairingClaimRequest, type PairingClaimResponse, type PairingStatusResponse } from '@pcloud/contracts';
import type { FastifyInstance } from 'fastify';
import { audit } from '../auth/sessions.ts';
import type { Db } from '../db/database.ts';
import { AppError } from '../errors.ts';
import { deviceFolder, type PairingService } from '../system/pairing.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';

export interface PairingRouteDeps {
  readonly db: Db;
  readonly clock: () => Date;
  readonly host: () => string;
  /** Límite de intentos por IP (lanza RATE_LIMITED). */
  readonly limit: (ip: string) => void;
}

export function registerPairingRoutes(app: FastifyInstance, ctx: RouteContext, pairing: PairingService, deps: PairingRouteDeps): void {
  /**
   * La carpeta compartida tiene que existir: si se borró (por SSH, o desde una versión anterior que
   * lo permitía), Samba rechaza el acceso incluso a las conexiones ya abiertas. Samba la busca por
   * su ruta en cada operación, así que con volver a crearla vacía basta. Pasa por el guardián:
   * sin disco listo no se crea nada.
   */
  const ensureShareFolder = async (share: string): Promise<void> => {
    try {
      await ctx.operations.createFolder('/', share);
    } catch {
      // ya existe (CONFLICT) o el disco no está listo: en ambos casos no hay nada que hacer aquí
    }
  };

  const status = async (): Promise<PairingStatusResponse> => {
    const share = await pairing.share();
    const current = share === null ? null : pairing.current(deps.clock());
    return {
      available: share !== null,
      share: share?.share ?? null,
      host: deps.host(),
      code: current?.code ?? null,
      expiresAt: current?.expiresAt.toISOString() ?? null,
    };
  };

  app.get(`${API}/pairing`, async (request): Promise<PairingStatusResponse> => {
    ctx.owner(request);
    return status();
  });

  app.post(`${API}/pairing/code`, async (request): Promise<PairingStatusResponse> => {
    const session = ctx.owner(request);
    const share = await pairing.share();
    if (share === null) {
      throw new AppError('CONFLICT', 'La carpeta de red no está instalada en este equipo');
    }
    await ensureShareFolder(share.share);
    pairing.createCode(deps.clock());
    audit(deps.db, { userId: session.userId, action: 'pairing.code', result: 'ok', ip: request.ip }, deps.clock());
    return status();
  });

  app.delete(`${API}/pairing/code`, async (request): Promise<PairingStatusResponse> => {
    ctx.owner(request);
    pairing.cancel();
    return status();
  });

  app.post(`${API}/pairing/claim`, { config: { public: true }, schema: { body: PairingClaimRequest } }, async (request): Promise<PairingClaimResponse> => {
    deps.limit(request.ip);
    const { code, device } = request.body as PairingClaimRequest;
    const share = await pairing.share();
    if (share === null) throw new AppError('NOT_FOUND', 'La carpeta de red no está instalada en este equipo');
    const folder = deviceFolder(device);
    if (!pairing.claim(code, deps.clock())) {
      audit(deps.db, { userId: null, action: 'pairing.claim', result: 'denied', ip: request.ip, detail: folder }, deps.clock());
      throw new AppError('FORBIDDEN', 'El código no es correcto o ha caducado. Pide uno nuevo en Ajustes de la nube.');
    }
    audit(deps.db, { userId: null, action: 'pairing.claim', result: 'ok', ip: request.ip, detail: folder }, deps.clock());
    await ensureShareFolder(share.share);
    return { host: deps.host(), share: share.share, user: share.user, password: share.password, folder };
  });
}
