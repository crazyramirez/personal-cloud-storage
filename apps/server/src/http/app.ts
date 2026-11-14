/**
 * API REST v1 (spec §8) sobre Fastify. Esta capa solo traduce HTTP ↔ dominio: las reglas de
 * rutas, almacenamiento y autenticación viven en sus módulos (spec §17.5).
 *
 * Seguridad (spec §11):
 *  - sesión en cookie HttpOnly + SameSite=Strict (+ Secure tras el proxy TLS);
 *  - toda petición que modifica estado exige la cabecera `x-pcloud-request` (un formulario de otro
 *    sitio no puede enviarla: protección CSRF sin estado);
 *  - límite de intentos en login y configuración inicial;
 *  - las descargas se sirven como adjunto, con `nosniff` y `CSP: sandbox` (contenido no fiable);
 *  - ninguna ruta de ficheros responde sin un lease vigente del StorageGuardian → 503.
 */

import { createReadStream } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import {
  API_ERROR_STATUS,
  CreateFolderRequest,
  Credentials,
  CSRF_HEADER,
  DownloadQuery,
  FsListQuery,
  SetupOwnerRequest,
  UPLOAD_CONTENT_TYPE,
  UPLOAD_LENGTH_HEADER,
  UPLOAD_OFFSET_HEADER,
  UploadInitRequest,
  UploadParams,
  volumeAllowsReads,
  type ApiErrorBody,
  type ApiErrorCode,
  type HealthResponse,
  type ResourcesResponse,
  type SessionUser,
  type SetupStatus,
  type StorageResponse,
} from '@pcloud/contracts';
import { burnVerification, hashPassword, verifyPassword } from '../auth/passwords.ts';
import {
  audit,
  consumeSetupToken,
  createSession,
  createUser,
  findSession,
  findUserForLogin,
  ownerExists,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  type SessionInfo,
} from '../auth/sessions.ts';
import type { PcloudConfig } from '../config/config.ts';
import { transaction, type Db } from '../db/database.ts';
import { AppError, errnoOf } from '../errors.ts';
import { ChallengeStore } from '../auth/webauthn.ts';
import { inlineContentType } from '../media/media.ts';
import { MediaService } from '../media/service.ts';
import { listDirectory, resolveDownload } from '../storage/files.ts';
import { FsOperations } from '../storage/operations.ts';
import { SerialQueue } from '../storage/serial.ts';
import { volumeSpace } from '../storage/space.ts';
import { StorageUnavailableError, toPublicStatus } from '../storage/storage-guardian.ts';
import type { UploadManager } from '../storage/uploads.ts';
import { contentDisposition, type GuardianLike, type RouteContext } from './context.ts';
import type { BackupService } from '../backup/service.ts';
import type { ResourceMonitor } from '../system/resources.ts';
import { registerAccountRoutes } from './routes-account.ts';
import { registerBackupRoutes } from './routes-backup.ts';
import { registerSystemRoutes } from './routes-system.ts';
import { registerFileRoutes } from './routes-files.ts';
import { registerMediaRoutes } from './routes-media.ts';

export type { GuardianLike } from './context.ts';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
  interface FastifyContextConfig {
    /** Ruta accesible sin sesión. */
    public?: boolean;
  }
}


export interface AppDeps {
  readonly config: PcloudConfig;
  readonly db: Db;
  readonly guardian: GuardianLike;
  readonly uploads: UploadManager;
  /** Operaciones del explorador; por defecto con cola propia (main.ts la comparte con las subidas). */
  readonly operations?: FsOperations;
  readonly media?: MediaService;
  readonly clock?: () => Date;
  readonly logger?: boolean;
  /** Nombre de la release desplegada (release.json); se publica en /system/health. */
  readonly release?: string | null;
  /** Copia de seguridad en disco externo (opcional: sin ella no hay rutas /backup). */
  readonly backup?: BackupService;
  /** Recursos del equipo para el panel (opcional). */
  readonly resources?: ResourceMonitor;
}

const API = '/api/v1';

/** Nombre con el que el servidor se anuncia por mDNS (avahi publica `<hostname>.local`). */
export const localName = (): string => `${hostname().split('.')[0]!.toLowerCase()}.local`;
const VOLUME_ERRNOS = new Set(['EIO', 'ENODEV', 'ENXIO', 'EROFS', 'ESTALE', 'ENOTCONN']);

/** Límite de intentos en memoria por clave (IP). */
class AttemptLimiter {
  readonly #max: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, windowMs: number) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** Registra un intento; lanza RATE_LIMITED si se supera el máximo en la ventana. */
  hit(key: string, now: number): void {
    const entry = this.#hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (this.#hits.size > 10_000) this.#hits.clear();
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return;
    }
    entry.count += 1;
    if (entry.count > this.#max) {
      throw new AppError('RATE_LIMITED', 'Demasiados intentos. Espera unos minutos y vuelve a probar.', {
        retryable: true,
        details: { retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) },
      });
    }
  }

  clear(key: string): void {
    this.#hits.delete(key);
  }
}

interface ErrorShape {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

function shapeOf(error: unknown): ErrorShape {
  if (error instanceof StorageUnavailableError) {
    return {
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
      message: error.message,
      retryable: error.retryable,
      details: { volumeState: error.volumeState, issues: error.issues },
    };
  }
  if (error instanceof AppError) {
    return { status: API_ERROR_STATUS[error.code], code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  const errno = errnoOf(error);
  if (errno !== undefined && VOLUME_ERRNOS.has(errno)) {
    return { status: 503, code: 'STORAGE_UNAVAILABLE', message: 'El disco ha dejado de responder durante la operación', retryable: true, details: { errno } };
  }
  if (errno === 'ENOSPC') {
    return { status: 507, code: 'INSUFFICIENT_STORAGE', message: 'El disco está lleno', retryable: false };
  }
  if (typeof error === 'object' && error !== null) {
    const fastifyError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (fastifyError.validation !== undefined) {
      return { status: 400, code: 'VALIDATION_FAILED', message: fastifyError.message ?? 'Petición no válida', retryable: false };
    }
    if (fastifyError.statusCode === 413) {
      return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Petición demasiado grande', retryable: false };
    }
    if (fastifyError.statusCode !== undefined && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return { status: 400, code: 'VALIDATION_FAILED', message: 'Petición no válida', retryable: false };
    }
  }
  return { status: 500, code: 'INTERNAL', message: 'Error interno', retryable: false };
}


/** Interpreta `Range: bytes=a-b` (un solo rango). null = sin rango válido que aplicar. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
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

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db, guardian, uploads } = deps;
  const clock = deps.clock ?? (() => new Date());
  const loginLimiter = new AttemptLimiter(10, 10 * 60 * 1000);

  const app = Fastify({
    logger: deps.logger === false ? false : { level: config.server.logLevel },
    trustProxy: '127.0.0.1',
    // Sin una línea de log por petición: el sondeo de la interfaz y los bloques de subida
    // escribirían sin parar en la microSD y dejarían nombres de archivo en el diario. Los
    // errores se registran aparte y las acciones relevantes van a audit_log.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024, // JSON de control; los bloques de subida van por streaming
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: true, useDefaults: false } },
  });

  await app.register(cookie);
  app.decorateRequest('session', null);
  // Los bloques de subida no se analizan ni se acumulan en memoria: se entrega el stream tal cual.
  app.addContentTypeParser(UPLOAD_CONTENT_TYPE, (_request, payload, done) => done(null, payload));

  const sendError = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    const shape = shapeOf(error);
    if (shape.status >= 500 && shape.code !== 'STORAGE_UNAVAILABLE') request.log.error({ err: error }, 'error no controlado');
    if (shape.code === 'STORAGE_UNAVAILABLE' && !(error instanceof StorageUnavailableError)) void guardian.check().catch(() => undefined);
    const body: ApiErrorBody = {
      error: {
        code: shape.code,
        message: shape.message,
        requestId: request.id,
        retryable: shape.retryable,
        ...(shape.details === undefined ? {} : { details: shape.details }),
      },
    };
    return reply.status(shape.status).send(body);
  };

  app.setErrorHandler((error, request, reply) => sendError(request, reply, error));
  app.setNotFoundHandler((request, reply) => sendError(request, reply, new AppError('NOT_FOUND', 'Ruta no encontrada')));

  app.addHook('onRequest', async (request, reply) => {
    // Cabeceras de seguridad de la API (Caddy no añade las suyas en /api: cada ruta decide).
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
      .header('referrer-policy', 'no-referrer')
      .header('cross-origin-resource-policy', 'same-origin');
    const safe = request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS';
    if (!safe && request.headers[CSRF_HEADER] !== '1') {
      throw new AppError('FORBIDDEN', `Falta la cabecera ${CSRF_HEADER}`);
    }
    const token = request.cookies[SESSION_COOKIE];
    request.session = token === undefined ? null : findSession(db, token, clock());
    if (request.routeOptions.config.public !== true && request.session === null) {
      throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar');
    }
  });

  const user = (request: FastifyRequest): SessionInfo => {
    if (request.session === null) throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar');
    return request.session;
  };

  const startSession = (request: FastifyRequest, reply: FastifyReply, userId: number): void => {
    const token = createSession(db, userId, { ip: request.ip, userAgent: request.headers['user-agent'] }, clock());
    void reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: request.protocol === 'https',
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    });
  };

  // ── Sistema ───────────────────────────────────────────────────────────────────────────────

  app.get(`${API}/system/health`, { config: { public: true } }, async (): Promise<HealthResponse> => ({
    status: 'ok',
    time: clock().toISOString(),
    volumeState: guardian.current.state,
    release: deps.release ?? null,
  }));

  app.get(`${API}/system/storage`, async (): Promise<StorageResponse> => {
    const status = toPublicStatus(await guardian.check());
    let space: StorageResponse['space'] = null;
    if (volumeAllowsReads(status.state)) {
      space = await volumeSpace(config.storage.mountpoint, config.storage).catch(() => null);
    }
    return { ...status, space };
  });

  // ── Configuración inicial y sesión ────────────────────────────────────────────────────────

  app.get(`${API}/setup/status`, { config: { public: true } }, async (): Promise<SetupStatus> => ({
    needsOwner: !ownerExists(db),
    localName: localName(),
  }));

  app.post(`${API}/setup/owner`, { config: { public: true }, schema: { body: SetupOwnerRequest } }, async (request, reply): Promise<SessionUser> => {
    loginLimiter.hit(`setup:${request.ip}`, clock().getTime());
    const body = request.body as SetupOwnerRequest;
    if (ownerExists(db)) throw new AppError('CONFLICT', 'La cuenta de propietario ya existe');
    const passwordHash = await hashPassword(body.password);
    const now = clock();
    const userId = transaction(db, () => {
      if (ownerExists(db)) throw new AppError('CONFLICT', 'La cuenta de propietario ya existe');
      if (!consumeSetupToken(db, body.token, now)) {
        audit(db, { action: 'setup.owner', result: 'denied', ip: request.ip }, now);
        return null;
      }
      const id = createUser(db, body.username, passwordHash, 'owner', now);
      audit(db, { userId: id, action: 'setup.owner', result: 'ok', ip: request.ip }, now);
      return id;
    });
    if (userId === null) throw new AppError('FORBIDDEN', 'El código de configuración no es válido o ha caducado');
    startSession(request, reply, userId);
    void reply.status(201);
    return { username: body.username, role: 'owner' };
  });

  app.post(`${API}/auth/login`, { config: { public: true }, schema: { body: Credentials } }, async (request, reply): Promise<SessionUser> => {
    const key = `login:${request.ip}`;
    loginLimiter.hit(key, clock().getTime());
    const body = request.body as Credentials;
    const found = findUserForLogin(db, body.username);
    const valid = found === null ? (await burnVerification(body.password), false) : await verifyPassword(body.password, found.passwordHash);
    if (found === null || !valid) {
      audit(db, { action: 'auth.login', result: 'denied', ip: request.ip, detail: body.username }, clock());
      throw new AppError('UNAUTHENTICATED', 'Usuario o contraseña incorrectos');
    }
    loginLimiter.clear(key);
    startSession(request, reply, found.id);
    audit(db, { userId: found.id, action: 'auth.login', result: 'ok', ip: request.ip }, clock());
    const session = findUserRole(db, found.id);
    return { username: session.username, role: session.role };
  });

  app.post(`${API}/auth/logout`, { config: { public: true } }, async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token !== undefined) revokeSession(db, token, clock());
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get(`${API}/auth/me`, async (request): Promise<SessionUser> => {
    const session = user(request);
    return { username: session.username, role: session.role };
  });

  // ── Explorador ────────────────────────────────────────────────────────────────────────────

  app.get(`${API}/fs/list`, { schema: { querystring: FsListQuery } }, async (request) => {
    const query = request.query as FsListQuery;
    const lease = await guardian.assertReadableVolume();
    return listDirectory(lease.dataRoot, query.path, { cursor: query.cursor, limit: query.limit });
  });

  app.post(`${API}/fs/folders`, { schema: { body: CreateFolderRequest } }, async (request, reply) => {
    const session = user(request);
    const body = request.body as CreateFolderRequest;
    const created = await ctx.operations.createFolder(body.path, body.name);
    audit(db, { userId: session.userId, action: 'fs.mkdir', path: created.path, result: 'ok', ip: request.ip }, clock());
    void reply.status(201);
    return created;
  });

  app.get(`${API}/fs/download`, { schema: { querystring: DownloadQuery } }, async (request, reply) => {
    const session = user(request);
    const query = request.query as DownloadQuery;
    const lease = await guardian.assertReadableVolume();
    const target = await resolveDownload(lease.dataRoot, query.path);
    const etag = `"${target.size.toString(16)}-${Math.floor(target.mtimeMs).toString(16)}"`;

    // «inline»: solo tipos seguros (imagen, audio, vídeo, PDF, texto). Lo demás, siempre adjunto.
    const inlineType = query.inline === '1' ? inlineContentType(target.name) : null;
    const isPdf = inlineType === 'application/pdf';
    void reply
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('last-modified', new Date(target.mtimeMs).toUTCString())
      .header('cache-control', 'private, no-cache')
      .header(
        'content-security-policy',
        inlineType === null
          ? "sandbox; default-src 'none'"
          : isPdf
            ? "default-src 'none'; frame-ancestors 'self'" // el visor PDF del navegador no funciona en «sandbox»
            : "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'",
      )
      .header('x-frame-options', inlineType === null ? 'DENY' : 'SAMEORIGIN')
      .header('content-type', inlineType ?? 'application/octet-stream')
      .header('content-disposition', contentDisposition(target.name, inlineType !== null));

    if (request.headers['if-none-match'] === etag) return reply.status(304).send();

    const ifRange = request.headers['if-range'];
    const range = ifRange !== undefined && ifRange !== etag ? null : parseRange(request.headers.range, target.size);
    if (range === 'unsatisfiable') {
      void reply.header('content-range', `bytes */${target.size}`);
      throw new AppError('RANGE_NOT_SATISFIABLE', 'El rango pedido no existe en el archivo');
    }
    if (range === null) {
      // Ver en la aplicación (miniaturas, visor) no es una descarga: no llena la actividad.
      if (inlineType === null) audit(db, { userId: session.userId, action: 'fs.download', path: query.path, result: 'ok', ip: request.ip }, clock());
      void reply.header('content-length', target.size);
      if (request.method === 'HEAD' || target.size === 0) return reply.send('');
      return reply.send(createReadStream(target.abs, { start: 0, end: target.size - 1 }));
    }
    void reply
      .status(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${target.size}`)
      .header('content-length', range.end - range.start + 1);
    if (request.method === 'HEAD') return reply.send('');
    return reply.send(createReadStream(target.abs, { start: range.start, end: range.end }));
  });

  // ── Subidas reanudables ───────────────────────────────────────────────────────────────────

  app.post(`${API}/uploads`, { schema: { body: UploadInitRequest } }, async (request, reply) => {
    const created = await uploads.create(user(request).userId, request.body as UploadInitRequest);
    void reply.status(201);
    return created;
  });

  app.get(`${API}/uploads/:id`, { schema: { params: UploadParams } }, async (request, reply) => {
    const { id } = request.params as UploadParams;
    const status = await uploads.status(user(request).userId, id);
    void reply.header(UPLOAD_OFFSET_HEADER, status.offset).header(UPLOAD_LENGTH_HEADER, status.size);
    return status;
  });

  app.patch(`${API}/uploads/:id`, { schema: { params: UploadParams } }, async (request, reply) => {
    const { id } = request.params as UploadParams;
    const rawOffset = request.headers[UPLOAD_OFFSET_HEADER];
    if (typeof rawOffset !== 'string' || !/^\d{1,16}$/.test(rawOffset)) {
      throw new AppError('VALIDATION_FAILED', `Falta la cabecera ${UPLOAD_OFFSET_HEADER}`);
    }
    if (request.headers['content-type'] !== UPLOAD_CONTENT_TYPE) {
      throw new AppError('VALIDATION_FAILED', `El contenido debe enviarse como ${UPLOAD_CONTENT_TYPE}`);
    }
    // Conexión medio abierta (el móvil perdió cobertura): sin datos en 2 min se corta, y la
    // subida queda libre para continuar desde el último punto confirmado.
    if (typeof request.raw.setTimeout === 'function') {
      request.raw.setTimeout(120_000, () => request.raw.destroy(new Error('bloque de subida sin datos')));
    }
    const offset = await uploads.append(user(request).userId, id, Number(rawOffset), request.body as AsyncIterable<Uint8Array>);
    return reply.status(204).header(UPLOAD_OFFSET_HEADER, offset).send();
  });

  app.post(`${API}/uploads/:id/complete`, { schema: { params: UploadParams } }, async (request) => {
    const session = user(request);
    const { id } = request.params as UploadParams;
    const done = await uploads.complete(session.userId, id);
    audit(db, { userId: session.userId, action: 'fs.upload', path: done.path, result: 'ok', ip: request.ip, detail: `${done.size} bytes` }, clock());
    return done;
  });

  app.delete(`${API}/uploads/:id`, { schema: { params: UploadParams } }, async (request, reply) => {
    const { id } = request.params as UploadParams;
    await uploads.cancel(user(request).userId, id);
    return reply.status(204).send();
  });

  // ── Explorador, papelera, visores, cuenta y actividad ─────────────────────────────────────

  const ctx: RouteContext = {
    config,
    db,
    guardian,
    operations:
      deps.operations ??
      new FsOperations({
        gate: guardian,
        serial: new SerialQueue(),
        minFreePercent: config.storage.minFreePercent,
        minFreeBytes: config.storage.minFreeBytes,
        trashRetentionDays: config.trash.enabled ? config.trash.retentionDays : null,
        clock,
      }),
    media: deps.media ?? new MediaService(guardian),
    clock,
    loginLimiter,
    challenges: new ChallengeStore(),
    user,
    owner: (request) => {
      const session = user(request);
      if (session.role !== 'owner') throw new AppError('FORBIDDEN', 'Solo el propietario puede hacer esto');
      return session;
    },
    startSession,
  };
  registerFileRoutes(app, ctx);
  registerMediaRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  if (deps.backup !== undefined) registerBackupRoutes(app, ctx, deps.backup);
  registerSystemRoutes(app, ctx);
  const resources = deps.resources;
  if (resources !== undefined) {
    app.get(`${API}/system/resources`, async (request): Promise<ResourcesResponse> => {
      user(request);
      return resources.snapshot();
    });
  }

  return app;
}

function findUserRole(db: Db, userId: number): SessionUser {
  const row = db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId);
  if (row === undefined) throw new AppError('UNAUTHENTICATED', 'Inicia sesión para continuar');
  return { username: String(row['username']), role: row['role'] === 'owner' ? 'owner' : 'user' };
}
