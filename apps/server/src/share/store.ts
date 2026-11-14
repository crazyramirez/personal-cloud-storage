/**
 * Enlaces para compartir (ADR-0018): persistencia en SQLite.
 *
 * - El token (32 bytes aleatorios, base64url) solo existe en el enlace: aquí se guarda su SHA-256.
 * - Un enlace siempre caduca (como mucho 30 días) y se puede revocar en cualquier momento.
 * - Nada aquí toca el disco de datos: la ruta se resuelve al servir, con el lease del guardián.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { ShareState, ShareView } from '@pcloud/contracts';
import type { Db } from '../db/database.ts';

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY = 24 * 60 * 60 * 1000;

export interface ShareRow {
  readonly id: string;
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly name: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly passwordHash: string | null;
  readonly maxDownloads: number | null;
  readonly downloads: number;
  readonly bytesSent: number;
  readonly lastAccessAt: string | null;
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

function rowOf(row: Record<string, unknown>): ShareRow {
  return {
    id: String(row['id']),
    path: String(row['path']),
    kind: row['kind'] === 'dir' ? 'dir' : 'file',
    name: String(row['name']),
    createdAt: String(row['created_at']),
    expiresAt: String(row['expires_at']),
    revokedAt: row['revoked_at'] === null ? null : String(row['revoked_at']),
    passwordHash: row['password_hash'] === null ? null : String(row['password_hash']),
    maxDownloads: row['max_downloads'] === null ? null : Number(row['max_downloads']),
    downloads: Number(row['downloads']),
    bytesSent: Number(row['bytes_sent']),
    lastAccessAt: row['last_access_at'] === null ? null : String(row['last_access_at']),
  };
}

export function stateOf(share: ShareRow, now: Date): ShareState {
  if (share.revokedAt !== null) return 'revoked';
  if (Date.parse(share.expiresAt) <= now.getTime()) return 'expired';
  if (share.maxDownloads !== null && share.downloads >= share.maxDownloads) return 'exhausted';
  return 'active';
}

export function viewOf(share: ShareRow, now: Date): ShareView {
  return {
    id: share.id,
    path: share.path,
    name: share.name,
    kind: share.kind,
    state: stateOf(share, now),
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    hasPassword: share.passwordHash !== null,
    maxDownloads: share.maxDownloads,
    downloads: share.downloads,
    bytesSent: share.bytesSent,
    lastAccessAt: share.lastAccessAt,
  };
}

export interface NewShare {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly name: string;
  readonly userId: number;
  readonly expiresInDays: number;
  readonly passwordHash: string | null;
  readonly maxDownloads: number | null;
}

export class ShareStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  create(input: NewShare, now: Date): { share: ShareRow; token: string } {
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(6).toString('hex');
    this.#db
      .prepare(
        `INSERT INTO shares (id, token_hash, path, kind, name, created_by, created_at, expires_at, password_hash, max_downloads)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        hashToken(token),
        input.path,
        input.kind,
        input.name,
        input.userId,
        now.toISOString(),
        new Date(now.getTime() + input.expiresInDays * DAY).toISOString(),
        input.passwordHash,
        input.maxDownloads,
      );
    return { share: this.get(id) as ShareRow, token };
  }

  get(id: string): ShareRow | null {
    const row = this.#db.prepare('SELECT * FROM shares WHERE id = ?').get(id);
    return row === undefined ? null : rowOf(row);
  }

  byToken(token: string): ShareRow | null {
    if (!SHARE_TOKEN.test(token)) return null;
    const row = this.#db.prepare('SELECT * FROM shares WHERE token_hash = ?').get(hashToken(token));
    return row === undefined ? null : rowOf(row);
  }

  /** Activos primero; los caducados o revocados se muestran 30 días y después se borran. */
  list(): ShareRow[] {
    return this.#db.prepare('SELECT * FROM shares ORDER BY created_at DESC LIMIT 500').all().map(rowOf);
  }

  revoke(id: string, now: Date): boolean {
    return Number(this.#db.prepare('UPDATE shares SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(now.toISOString(), id).changes) > 0;
  }

  /** Quita del todo un enlace que ya no funciona (revocado, caducado o agotado). */
  remove(id: string): boolean {
    return Number(this.#db.prepare('DELETE FROM shares WHERE id = ?').run(id).changes) > 0;
  }

  countActive(now: Date): number {
    return this.list().filter((share) => stateOf(share, now) === 'active').length;
  }

  /** Cuenta una descarga completa (o el inicio de una). */
  countDownload(id: string, now: Date): void {
    this.#db.prepare('UPDATE shares SET downloads = downloads + 1, last_access_at = ? WHERE id = ?').run(now.toISOString(), id);
  }

  addBytes(id: string, bytes: number): void {
    if (bytes > 0) this.#db.prepare('UPDATE shares SET bytes_sent = bytes_sent + ? WHERE id = ?').run(Math.round(bytes), id);
  }

  /** Último acceso, como mucho una escritura por minuto y enlace (la base está en la microSD). */
  touch(share: ShareRow, now: Date): void {
    if (share.lastAccessAt !== null && now.getTime() - Date.parse(share.lastAccessAt) < 60_000) return;
    this.#db.prepare('UPDATE shares SET last_access_at = ? WHERE id = ?').run(now.toISOString(), share.id);
  }

  /** Borra los enlaces que dejaron de funcionar hace más de 30 días. */
  purge(now: Date): number {
    const cutoff = new Date(now.getTime() - 30 * DAY).toISOString();
    return Number(
      this.#db.prepare('DELETE FROM shares WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(cutoff, cutoff).changes,
    );
  }
}
