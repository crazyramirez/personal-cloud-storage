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
import type { SearchIndex } from '../storage/search-index.ts';
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
  /** Índice de nombres para la búsqueda (opcional: sin él, la búsqueda recorre en directo). */
  readonly searchIndex?: SearchIndex | undefined;
  /** Avisa al índice de que estas rutas se crearon o cambiaron desde la web. */
  indexTouched(paths: readonly string[]): void;
  readonly clock: () => Date;
  readonly loginLimiter: AttemptLimit;
  readonly challenges: ChallengeStore;
  /** Carpetas que no se pueden borrar, mover ni renombrar (p. ej. «/Copias» de la carpeta de red, ADR-0022). */
  readonly systemFolders: () => Promise<readonly string[]>;
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

/** Interpreta `Range: bytes=a-b` (un solo rango). null = sin rango válido que aplicar. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match !== null && size === 0) return 'unsatisfiable';
  if (match === null) return null; // multirrango u otra unidad: se sirve completo
  const [, rawStart = '', rawEnd = ''] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
