/**
 * Rutas de cuenta y seguridad: contraseña, sesiones abiertas, llaves de acceso (passkeys),
 * usuarios (propietario) y registro de actividad.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  ActivityQuery,
  ChangePasswordRequest,
  ClientErrorReport,
  CreateUserRequest,
  IdParams,
  PasskeyLoginRequest,
  PasskeyRegisterOptionsRequest,
  PasskeyRegisterRequest,
  RenamePasskeyRequest,
  ResetPasswordRequest,
  UserIdParams,
  type ActivityResponse,
  type PasskeyListResponse,
  type PasskeyLoginOptions,
  type PasskeyRegisterOptions,
  type SessionListResponse,
  type SessionUser,
  type UserListResponse,
} from '@pcloud/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { hashPassword, verifyPassword } from '../auth/passwords.ts';
import { audit, SESSION_COOKIE } from '../auth/sessions.ts';
import { SUPPORTED_ALGORITHMS, verifyAssertion, verifyRegistration } from '../auth/webauthn.ts';
import { transaction } from '../db/database.ts';
import { AppError } from '../errors.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Identificador público de una sesión: prefijo del hash guardado (nunca el token). */
const publicSessionId = (id: string): string => id.slice(0, 16);

export function registerAccountRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { db, clock, challenges } = ctx;

  /** RP ID y origen de WebAuthn: el nombre con el que se ha abierto la aplicación. */
  const relyingParty = (request: FastifyRequest): { rpId: string; origin: string } => {
    const host = request.hostname.toLowerCase();
    const secure = request.protocol === 'https' || host === 'localhost';
    if (!secure || IPV4.test(host) || host.includes(':') || host === '') {
      throw new AppError(
        'VALIDATION_FAILED',
        'Las llaves de acceso necesitan abrir la aplicación por su nombre con HTTPS (por ejemplo https://nombre-del-servidor.local), no por la dirección IP.',
      );
    }
    // Origen exacto que verá el navegador: esquema + cabecera Host (incluye el puerto si no es el estándar).
    return { rpId: host, origin: `${request.protocol}://${request.host.toLowerCase()}` };
  };

  const currentSessionId = (request: FastifyRequest): string | null => {
    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined) return null;
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sha256Hex(token));
    return row === undefined ? null : String(row['id']);
  };

  // ── Errores del cliente ───────────────────────────────────────────────────────────────────
  // Se registran en el diario del servidor (nunca salen de la Pi). Pública porque los fallos
  // pueden ocurrir antes de iniciar sesión; limitada por IP y por tamaño.
  const reports = new Map<string, { count: number; resetAt: number }>();
  app.post(`${API}/client-errors`, { config: { public: true }, schema: { body: ClientErrorReport } }, async (request, reply) => {
    const now = clock().getTime();
    const entry = reports.get(request.ip);
    if (entry === undefined || entry.resetAt <= now) {
      if (reports.size > 1000) reports.clear();
      reports.set(request.ip, { count: 1, resetAt: now + 60_000 });
    } else if (++entry.count > 10) {
      return reply.status(204).send();
    }
    const body = request.body as ClientErrorReport;
    request.log.warn(
      { client: { ...body, userAgent: request.headers['user-agent']?.slice(0, 200), user: request.session?.username ?? null } },
      'error en el navegador',
    );
    return reply.status(204).send();
  });

  // ── Contraseña ────────────────────────────────────────────────────────────────────────────

  app.post(`${API}/auth/password`, { schema: { body: ChangePasswordRequest } }, async (request, reply) => {
    const session = ctx.user(request);
    const body = request.body as ChangePasswordRequest;
    ctx.loginLimiter.hit(`password:${session.userId}`, clock().getTime());
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.userId);
    if (row === undefined || !(await verifyPassword(body.currentPassword, String(row['password_hash'])))) {
      audit(db, { userId: session.userId, action: 'auth.password', result: 'denied', ip: request.ip }, clock());
      throw new AppError('FORBIDDEN', 'La contraseña actual no es correcta');
    }
    const hash = await hashPassword(body.newPassword);
    const current = currentSessionId(request);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, session.userId);
      if (body.signOutOthers !== false) {
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL').run(clock().toISOString(), session.userId, current ?? '');
      }
    });
    ctx.loginLimiter.clear(`password:${session.userId}`);
    audit(db, { userId: session.userId, action: 'auth.password', result: 'ok', ip: request.ip }, clock());
    return reply.status(204).send();
  });

  // ── Sesiones abiertas ─────────────────────────────────────────────────────────────────────

  app.get(`${API}/auth/sessions`, async (request): Promise<SessionListResponse> => {
    const session = ctx.user(request);
    const current = currentSessionId(request);
    const rows = db
      .prepare(
        `SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 100`,
      )
      .all(session.userId, clock().toISOString());
    return {
      sessions: rows.map((row) => ({
        id: publicSessionId(String(row['id'])),
        current: String(row['id']) === current,
        createdAt: String(row['created_at']),
        lastSeenAt: String(row['last_seen_at']),
        ip: row['ip'] === null ? null : String(row['ip']),
        userAgent: row['user_agent'] === null ? null : String(row['user_agent']),
      })),
    };
  });

  app.delete(`${API}/auth/sessions/:id`, { schema: { params: IdParams } }, async (request, reply) => {
    const session = ctx.user(request);
    const { id } = request.params as IdParams;
    if (!/^[0-9a-f]{16}$/.test(id)) throw new AppError('NOT_FOUND', 'Sesión no encontrada');
    const changes = Number(
      db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND substr(id, 1, 16) = ? AND revoked_at IS NULL").run(clock().toISOString(), session.userId, id).changes,
    );
    if (changes === 0) throw new AppError('NOT_FOUND', 'Sesión no encontrada');
    audit(db, { userId: session.userId, action: 'auth.session.revoke', result: 'ok', ip: request.ip }, clock());
    return reply.status(204).send();
  });

  // ── Llaves de acceso (passkeys) ───────────────────────────────────────────────────────────

  app.get(`${API}/auth/passkeys`, async (request): Promise<PasskeyListResponse> => {
    const session = ctx.user(request);
    const rows = db.prepare('SELECT id, name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(session.userId);
    return {
      passkeys: rows.map((row) => ({
        id: String(row['id']),
        name: String(row['name']),
        createdAt: String(row['created_at']),
        lastUsedAt: row['last_used_at'] === null ? null : String(row['last_used_at']),
      })),
    };
  });

  app.post(`${API}/auth/passkeys/register/options`, { schema: { body: PasskeyRegisterOptionsRequest } }, async (request): Promise<PasskeyRegisterOptions> => {
    const session = ctx.user(request);
    const { rpId, origin } = relyingParty(request);
    ctx.loginLimiter.hit(`password:${session.userId}`, clock().getTime());
    const hashRow = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.userId);
    if (hashRow === undefined || !(await verifyPassword((request.body as PasskeyRegisterOptionsRequest).password, String(hashRow['password_hash'])))) {
      audit(db, { userId: session.userId, action: 'auth.passkey.add', result: 'denied', ip: request.ip, detail: 'contraseña incorrecta' }, clock());
      throw new AppError('FORBIDDEN', 'La contraseña no es correcta');
    }
    ctx.loginLimiter.clear(`password:${session.userId}`);
    let handle = db.prepare('SELECT webauthn_id FROM users WHERE id = ?').get(session.userId)?.['webauthn_id'];
    if (handle === null || handle === undefined) {
      handle = randomBytes(32).toString('base64url');
      db.prepare('UPDATE users SET webauthn_id = ? WHERE id = ?').run(handle, session.userId);
    }
    const existing = db.prepare('SELECT id FROM passkeys WHERE user_id = ?').all(session.userId);
    return {
      challenge: challenges.issue('register', session.userId, rpId, origin, clock().getTime()),
      rp: { id: rpId, name: 'Personal Cloud' },
      user: { id: String(handle), name: session.username, displayName: session.username },
      pubKeyCredParams: SUPPORTED_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
      excludeCredentials: existing.map((row) => ({ type: 'public-key' as const, id: String(row['id']) })),
      timeout: 120_000,
    };
  });

  app.post(`${API}/auth/passkeys/register`, { schema: { body: PasskeyRegisterRequest } }, async (request, reply) => {
    const session = ctx.user(request);
    const body = request.body as PasskeyRegisterRequest;
    const credential = verifyRegistration(body, challenges, session.userId, clock().getTime());
    if (credential.id !== body.id) throw new AppError('VALIDATION_FAILED', 'WebAuthn: identificador de credencial incoherente');
    try {
      db.prepare('INSERT INTO passkeys (id, user_id, public_key, algorithm, sign_count, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        credential.id, session.userId, credential.publicKey, credential.algorithm, credential.signCount, body.name.trim().slice(0, 64), clock().toISOString(),
      );
    } catch {
      throw new AppError('CONFLICT', 'Esta llave de acceso ya está registrada');
    }
    audit(db, { userId: session.userId, action: 'auth.passkey.add', result: 'ok', ip: request.ip, detail: body.name }, clock());
    void reply.status(201);
    return { id: credential.id, name: body.name };
  });

  app.patch(`${API}/auth/passkeys/:id`, { schema: { params: IdParams, body: RenamePasskeyRequest } }, async (request, reply) => {
    const session = ctx.user(request);
    const { id } = request.params as IdParams;
    const { name } = request.body as RenamePasskeyRequest;
    const changes = Number(db.prepare('UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?').run(name.trim(), id, session.userId).changes);
    if (changes === 0) throw new AppError('NOT_FOUND', 'Llave de acceso no encontrada');
    return reply.status(204).send();
  });

  app.delete(`${API}/auth/passkeys/:id`, { schema: { params: IdParams } }, async (request, reply) => {
    const session = ctx.user(request);
    const { id } = request.params as IdParams;
    const changes = Number(db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?').run(id, session.userId).changes);
    if (changes === 0) throw new AppError('NOT_FOUND', 'Llave de acceso no encontrada');
    audit(db, { userId: session.userId, action: 'auth.passkey.remove', result: 'ok', ip: request.ip }, clock());
    return reply.status(204).send();
  });

  // Sin límite de intentos aquí: la página de entrar pide un reto en cada visita (autocompletado de
  // llaves). Los retos están acotados en memoria y el intento real se limita al verificarlo.
  app.post(`${API}/auth/passkeys/login/options`, { config: { public: true } }, async (request): Promise<PasskeyLoginOptions> => {
    const { rpId, origin } = relyingParty(request);
    return { challenge: challenges.issue('login', null, rpId, origin, clock().getTime()), rpId, timeout: 120_000 };
  });

  app.post(`${API}/auth/passkeys/login`, { config: { public: true }, schema: { body: PasskeyLoginRequest } }, async (request, reply): Promise<SessionUser> => {
    const body = request.body as PasskeyLoginRequest;
    const key = `login:${request.ip}`;
    ctx.loginLimiter.hit(key, clock().getTime());
    const row = db
      .prepare(
        `SELECT p.user_id, p.public_key, p.algorithm, p.sign_count, u.username, u.role
           FROM passkeys p JOIN users u ON u.id = p.user_id
          WHERE p.id = ? AND u.disabled_at IS NULL`,
      )
      .get(body.id);
    if (row === undefined) {
      audit(db, { action: 'auth.passkey.login', result: 'denied', ip: request.ip, detail: 'llave desconocida' }, clock());
      throw new AppError('UNAUTHENTICATED', 'Esta llave de acceso no está registrada en este servidor');
    }
    const userId = Number(row['user_id']);
    let signCount: number;
    try {
      signCount = verifyAssertion(
        body,
        challenges,
        { algorithm: Number(row['algorithm']), publicKey: String(row['public_key']), signCount: Number(row['sign_count']) },
        clock().getTime(),
      );
    } catch (error) {
      audit(db, { userId, action: 'auth.passkey.login', result: 'denied', ip: request.ip }, clock());
      throw error;
    }
    db.prepare('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE id = ?').run(signCount, clock().toISOString(), body.id);
    ctx.loginLimiter.clear(key);
    ctx.startSession(request, reply, userId);
    audit(db, { userId, action: 'auth.passkey.login', result: 'ok', ip: request.ip }, clock());
    return { username: String(row['username']), role: row['role'] === 'owner' ? 'owner' : 'user' };
  });

  // ── Usuarios (propietario) ────────────────────────────────────────────────────────────────

  app.get(`${API}/users`, async (request): Promise<UserListResponse> => {
    ctx.owner(request);
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.created_at, u.disabled_at, (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
           FROM users u ORDER BY u.id`,
      )
      .all();
    return {
      users: rows.map((row) => ({
        id: Number(row['id']),
        username: String(row['username']),
        role: row['role'] === 'owner' ? 'owner' : 'user',
        createdAt: String(row['created_at']),
        disabled: row['disabled_at'] !== null,
        passkeys: Number(row['passkeys']),
      })),
    };
  });

  app.post(`${API}/users`, { schema: { body: CreateUserRequest } }, async (request, reply) => {
    const session = ctx.owner(request);
    const body = request.body as CreateUserRequest;
    const hash = await hashPassword(body.password);
    let id: number;
    try {
      id = Number(db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(body.username, hash, body.role, clock().toISOString()).lastInsertRowid);
    } catch {
      throw new AppError('CONFLICT', 'Ya existe un usuario con ese nombre');
    }
    audit(db, { userId: session.userId, action: 'users.add', result: 'ok', ip: request.ip, detail: `${body.username} (${body.role})` }, clock());
    void reply.status(201);
    return { id };
  });

  app.post(`${API}/users/:id/password`, { schema: { params: UserIdParams, body: ResetPasswordRequest } }, async (request, reply) => {
    const session = ctx.owner(request);
    const { id } = request.params as UserIdParams;
    const hash = await hashPassword((request.body as ResetPasswordRequest).password);
    transaction(db, () => {
      const changes = Number(db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id).changes);
      if (changes === 0) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      if (id !== session.userId) {
        // Restablecer la contraseña de otro usuario suele significar cuenta comprometida: se cierran
        // sus sesiones y se retiran sus llaves de acceso (tendrá que volver a añadirlas).
        db.prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(clock().toISOString(), id);
        db.prepare('DELETE FROM passkeys WHERE user_id = ?').run(id);
      }
    });
    audit(db, { userId: session.userId, action: 'users.password', result: 'ok', ip: request.ip, detail: `usuario ${id}` }, clock());
    return reply.status(204).send();
  });

  app.delete(`${API}/users/:id`, { schema: { params: UserIdParams } }, async (request, reply) => {
    const session = ctx.owner(request);
    const { id } = request.params as UserIdParams;
    if (id === session.userId) throw new AppError('CONFLICT', 'No puedes eliminar tu propia cuenta');
    transaction(db, () => {
      const target = db.prepare('SELECT role FROM users WHERE id = ?').get(id);
      if (target === undefined) throw new AppError('NOT_FOUND', 'Usuario no encontrado');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
    audit(db, { userId: session.userId, action: 'users.remove', result: 'ok', ip: request.ip, detail: `usuario ${id}` }, clock());
    return reply.status(204).send();
  });

  // ── Actividad ─────────────────────────────────────────────────────────────────────────────

  app.get(`${API}/activity`, { schema: { querystring: ActivityQuery } }, async (request): Promise<ActivityResponse> => {
    const session = ctx.user(request);
    const query = request.query as ActivityQuery;
    const limit = query.limit ?? 50;
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    // Cada usuario ve su actividad; el propietario ve la de todos.
    if (session.role !== 'owner') {
      conditions.push('a.user_id = ?');
      params.push(session.userId);
    }
    if (query.before !== undefined) {
      conditions.push('a.id < ?');
      params.push(query.before);
    }
    if (query.action !== undefined) {
      conditions.push("a.action LIKE ? ESCAPE '\\'");
      params.push(`${query.action.replace(/[%_\\]/g, '\\$&')}%`);
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = db
      .prepare(
        `SELECT a.id, a.at, u.username, a.action, a.path, a.result, a.ip, a.detail
           FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where}
          ORDER BY a.id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const page = rows.slice(0, limit);
    return {
      entries: page.map((row) => ({
        id: Number(row['id']),
        at: String(row['at']),
        username: row['username'] === null ? null : String(row['username']),
        action: String(row['action']),
        path: row['path'] === null ? null : String(row['path']),
        result: String(row['result']),
        ip: row['ip'] === null ? null : String(row['ip']),
        detail: row['detail'] === null ? null : String(row['detail']),
      })),
      nextBefore: rows.length > limit ? Number(page.at(-1)?.['id']) : null,
    };
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
