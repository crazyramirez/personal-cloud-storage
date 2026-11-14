/**
 * Copia de seguridad en disco externo (ADR-0017). Todo es del propietario: ver discos, asignar,
 * sincronizar, cancelar, expulsar y ajustes.
 */

import { BackupAssignRequest, BackupSettingsRequest, BackupStartRequest, type BackupHistoryResponse, type BackupStatusResponse } from '@pcloud/contracts';
import type { FastifyInstance } from 'fastify';
import type { BackupService } from '../backup/service.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';

export function registerBackupRoutes(app: FastifyInstance, ctx: RouteContext, backup: BackupService): void {
  app.get(`${API}/backup`, async (request): Promise<BackupStatusResponse> => {
    ctx.owner(request);
    return backup.status();
  });

  app.get(`${API}/backup/history`, async (request): Promise<BackupHistoryResponse> => {
    ctx.owner(request);
    return { runs: backup.history(20) };
  });

  app.post(`${API}/backup/assign`, { schema: { body: BackupAssignRequest } }, async (request): Promise<BackupStatusResponse> => {
    const session = ctx.owner(request);
    await backup.assign((request.body as BackupAssignRequest).uuid, session.userId);
    return backup.status();
  });

  app.delete(`${API}/backup/assign`, async (request): Promise<BackupStatusResponse> => {
    const session = ctx.owner(request);
    backup.unassign(session.userId);
    return backup.status();
  });

  app.post(`${API}/backup/start`, { schema: { body: BackupStartRequest } }, async (request): Promise<BackupStatusResponse> => {
    const session = ctx.owner(request);
    await backup.startSync((request.body as BackupStartRequest).confirm === true, session.userId);
    return backup.status();
  });

  app.post(`${API}/backup/cancel`, async (request): Promise<BackupStatusResponse> => {
    ctx.owner(request);
    backup.cancel();
    return backup.status();
  });

  app.post(`${API}/backup/eject`, async (request): Promise<BackupStatusResponse> => {
    ctx.owner(request);
    await backup.eject();
    return backup.status();
  });

  app.patch(`${API}/backup/settings`, { schema: { body: BackupSettingsRequest } }, async (request): Promise<BackupStatusResponse> => {
    ctx.owner(request);
    backup.setSettings(request.body as BackupSettingsRequest);
    return backup.status();
  });
}
