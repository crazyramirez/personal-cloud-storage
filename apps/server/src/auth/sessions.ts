/**
 * Sesiones web y usuarios (spec §11): token opaco aleatorio en cookie HttpOnly; en la base solo
 * se guarda su SHA-256. Token de un solo uso para crear la cuenta de propietario.
 */

import { createHash, randomBytes } from 'node:crypto';
import { transaction, type Db } from '../db/database.ts';

export const SESSION_COOKIE = 'pcloud_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000; // no escribir en la microSD en cada petición
const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: sin I, L, O, U

export type Role = 'owner' | 'user';

export interface SessionInfo {
  readonly userId: number;
  readonly username: string;
  readonly role: Role;
}

export interface RequestMeta {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// ── Usuarios ────────────────────────────────────────────────────────────────────────────────

export function ownerExists(db: Db): boolean {
  return db.prepare("SELECT 1 FROM users WHERE role = 'owner' AND disabled_at IS NULL LIMIT 1").get() !== undefined;
}

export function createUser(db: Db, username: string, passwordHash: string, role: Role, now: Date): number {
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)')
    .run(username, passwordHash, role, now.toISOString());
  return Number(result.lastInsertRowid);
}

export function findUserForLogin(db: Db, username: string): { id: number; passwordHash: string } | null {
  const row = db.prepare('SELECT id, password_hash FROM users WHERE username = ? AND disabled_at IS NULL').get(username);
  return row === undefined ? null : { id: Number(row['id']), passwordHash: String(row['password_hash']) };
}

export function deleteUser(db: Db, username: string): boolean {
  return Number(db.prepare('DELETE FROM users WHERE username = ?').run(username).changes) > 0;
}

// ── Sesiones ────────────────────────────────────────────────────────────────────────────────

export function createSession(db: Db, userId: number, meta: RequestMeta, now: Date): string {
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    sha256(token),
    userId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    now.toISOString(),
    meta.ip ?? null,
    meta.userAgent?.slice(0, 256) ?? null,
  );
  return token;
}

export function findSession(db: Db, token: string, now: Date): SessionInfo | null {
  if (token.length < 20 || token.length > 128) return null;
  const id = sha256(token);
  const row = db
    .prepare(
      `SELECT s.last_seen_at, u.id AS user_id, u.username, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
    .get(id, now.toISOString());
  if (row === undefined) return null;
  if (now.getTime() - Date.parse(String(row['last_seen_at'])) > TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now.toISOString(), id);
  }
  return { userId: Number(row['user_id']), username: String(row['username']), role: row['role'] === 'owner' ? 'owner' : 'user' };
}

export function revokeSession(db: Db, token: string, now: Date): void {
  db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), sha256(token));
}

export function purgeExpiredSessions(db: Db, now: Date): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now.toISOString());
}

// ── Token de configuración inicial ──────────────────────────────────────────────────────────

function normalizeSetupToken(token: string): string {
  return token.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** Genera un token nuevo (invalida los anteriores sin usar). Formato legible: XXXXX-XXXXX-XXXXX-XXXXX. */
export function issueSetupToken(db: Db, now: Date): string {
  const bytes = randomBytes(20);
  let raw = '';
  for (const byte of bytes) raw += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
  transaction(db, () => {
    db.prepare('DELETE FROM setup_tokens WHERE used_at IS NULL').run();
    db.prepare('INSERT INTO setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(
      sha256(raw),
      now.toISOString(),
      new Date(now.getTime() + SETUP_TOKEN_TTL_MS).toISOString(),
    );
  });
  return raw.replace(/(.{5})(?=.)/g, '$1-');
}

/** Marca el token como usado si es válido. Atómico: dos peticiones simultáneas no pueden usarlo dos veces. */
export function consumeSetupToken(db: Db, token: string, now: Date): boolean {
  const result = db
    .prepare('UPDATE setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
    .run(now.toISOString(), sha256(normalizeSetupToken(token)), now.toISOString());
  return Number(result.changes) === 1;
}

export function hasValidSetupToken(db: Db, now: Date): boolean {
  return db.prepare('SELECT 1 FROM setup_tokens WHERE used_at IS NULL AND expires_at > ? LIMIT 1').get(now.toISOString()) !== undefined;
}

// ── Auditoría ───────────────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  readonly userId?: number | null | undefined;
  readonly action: string;
  readonly path?: string | undefined;
  readonly result: 'ok' | 'denied' | 'error';
  readonly ip?: string | undefined;
  readonly detail?: string | undefined;
}

/** Nunca registra contenidos, contraseñas ni tokens. */
export function audit(db: Db, entry: AuditEntry, now: Date): void {
  db.prepare('INSERT INTO audit_log (at, user_id, action, path, result, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    now.toISOString(),
    entry.userId ?? null,
    entry.action,
    entry.path ?? null,
    entry.result,
    entry.ip ?? null,
    entry.detail?.slice(0, 500) ?? null,
  );
}
