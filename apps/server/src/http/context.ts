/**
 * Lo que comparten los módulos de rutas. Lo construye buildApp().
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { SessionInfo } from '../auth/sessions.ts';
import type { ChallengeStore } from '../auth/webauthn.ts';
import type { PcloudConfig } from '../config/config.ts';
import type { Db } from '../db/database.ts';
import type { MediaService } from '../media/service.ts';
import type { FsOperations } from '../storage/operations.ts';
import type { VolumeSnapshot } from '../storage/storage-guardian.ts';
import type { VolumeGate } from '../storage/uploads.ts';

export interface GuardianLike extends VolumeGate {
  check(): Promise<VolumeSnapshot>;
  readonly current: VolumeSnapshot;
}

export interface AttemptLimit {
  hit(key: string, now: number): void;
  clear(key: string): void;
}

export interface RouteContext {
  readonly config: PcloudConfig;
  readonly db: Db;
  readonly guardian: GuardianLike;
  readonly operations: FsOperations;
  readonly media: MediaService;
  readonly clock: () => Date;
  readonly loginLimiter: AttemptLimit;
  readonly challenges: ChallengeStore;
  /** Sesión de la petición o 401. */
  user(request: FastifyRequest): SessionInfo;
  /** Sesión de propietario o 403. */
  owner(request: FastifyRequest): SessionInfo;
  startSession(request: FastifyRequest, reply: FastifyReply, userId: number): void;
}

/** Content-Disposition con nombre ASCII de respaldo y nombre UTF-8 (RFC 6266/5987). */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
