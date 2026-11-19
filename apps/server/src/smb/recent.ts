/**
 * Recientes de la carpeta de red (ADR-0024).
 *
 * Lo que los ordenadores copian por SMB (DEV Backup Studio) no pasa por la API, así que no queda
 * en audit_log. Samba lo anota con el módulo `full_audit` en el diario del sistema; el servicio
 * pcloud-smb-recent lee esas líneas, las convierte en rutas del cliente con `parseAuditMessage` y
 * las guarda con `SmbRecentStore`. Recientes (Panel) las mezcla con las de la web.
 *
 * Formato de cada línea (vfs_full_audit, con `full_audit:prefix = %P`):
 *   <raíz de la carpeta>|<operación>|ok|<argumentos…>
 *   mkdirat     → <ruta>
 *   renameat    → <origen>|<destino>
 *   create_file → <máscara de acceso>|file|dir|<disposición>|<ruta>
 * Las rutas son absolutas (las relativas se resuelven contra el prefijo). Nombres de Windows no
 * admiten «|», así que partir por «|» es seguro.
 */

import path from 'node:path';
import { transaction, type Db } from '../db/database.ts';
import { formatClientPath, parseClientPath } from '../storage/paths.ts';

/** Filas que se conservan: de sobra para las 12 de Recientes aunque muchas ya no existan. */
export const SMB_RECENT_KEEP = 500;

/** Disposiciones de create_file que crean o reescriben un archivo. */
const WRITE_DISPOSITIONS = new Set(['create', 'overwrite', 'overwrite_if', 'supersede']);
/** FILE_WRITE_DATA | FILE_APPEND_DATA | GENERIC_ALL | GENERIC_WRITE. */
const WRITE_ACCESS = 0x2 | 0x4 | 0x10000000 | 0x40000000;
/** Temporales y archivos de sistema que no interesa ver en Recientes. */
const JUNK = /^(~\$|\.~lock|\._)|^(thumbs\.db|desktop\.ini|\.ds_store)$|\.(tmp|part|partial|crdownload)$/i;

export type AuditEvent =
  | { readonly kind: 'write'; readonly path: string }
  | { readonly kind: 'rename'; readonly from: string; readonly path: string };

/**
 * Convierte una línea de full_audit en un evento con rutas del cliente (`/DEV_Backup_Studio/…`).
 * Devuelve null si no es una escritura correcta, si cae fuera de la raíz de datos o es un
 * temporal.
 */
export function parseAuditMessage(message: string, dataRoot: string): AuditEvent | null {
  const parts = message.trim().split('|');
  if (parts.length < 4) return null;
  const [prefix = '', op, result, ...args] = parts;
  if (result !== 'ok') return null;
  const toClient = (raw: string | undefined): string | null => clientPathOf(raw, prefix, dataRoot);

  if (op === 'mkdirat' && args.length === 1) {
    const p = toClient(args[0]);
    return p === null ? null : { kind: 'write', path: p };
  }
  if (op === 'renameat' && args.length === 2) {
    const to = toClient(args[1]);
    if (to === null) return null;
    return { kind: 'rename', from: toClient(args[0]) ?? '', path: to };
  }
  if (op === 'create_file' && args.length === 4) {
    const [mask, type, disposition = ''] = args;
    const access = Number.parseInt(mask ?? '', 16);
    const writes =
      WRITE_DISPOSITIONS.has(disposition) ||
      (type === 'file' && disposition === 'open_if' && Number.isFinite(access) && (access & WRITE_ACCESS) !== 0);
    // Abrir una carpeta (listarla) también es create_file: solo cuenta si se crea.
    if (!writes || (type === 'dir' && disposition !== 'create')) return null;
    const p = toClient(args[3]);
    return p === null ? null : { kind: 'write', path: p };
  }
  return null;
}

function clientPathOf(raw: string | undefined, prefix: string, dataRoot: string): string | null {
  if (raw === undefined || raw === '' || raw.includes(':')) return null; // «:» = flujo alternativo
  const abs = path.posix.normalize(path.posix.isAbsolute(raw) ? raw : path.posix.join(prefix, raw));
  const rel = path.posix.relative(dataRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.posix.isAbsolute(rel)) return null;
  if (JUNK.test(path.posix.basename(rel))) return null;
  try {
    return formatClientPath(parseClientPath(rel));
  } catch {
    return null; // ruta reservada (.pcloud…) o inválida
  }
}

export interface SmbRecentRow {
  readonly path: string;
  readonly at: string;
}

export class SmbRecentStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** Guarda un lote de eventos y la posición del diario en una sola transacción. */
  record(events: ReadonlyArray<{ readonly event: AuditEvent; readonly at: string }>, cursor: string | null): void {
    transaction(this.#db, () => {
      const upsert = this.#db.prepare('INSERT INTO smb_recent (path, at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET at = excluded.at');
      const drop = this.#db.prepare('DELETE FROM smb_recent WHERE path = ?');
      for (const { event, at } of events) {
        if (event.kind === 'rename' && event.from !== '') drop.run(event.from);
        upsert.run(event.path, at);
      }
      if (cursor !== null) {
        this.#db.prepare("INSERT INTO smb_audit_state (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(cursor);
      }
      this.#db
        .prepare('DELETE FROM smb_recent WHERE path NOT IN (SELECT path FROM smb_recent ORDER BY at DESC LIMIT ?)')
        .run(SMB_RECENT_KEEP);
    });
  }

  cursor(): string | null {
    const row = this.#db.prepare("SELECT value FROM smb_audit_state WHERE key = 'cursor'").get();
    return row === undefined ? null : String(row['value']);
  }

  forgetCursor(): void {
    this.#db.prepare("DELETE FROM smb_audit_state WHERE key = 'cursor'").run();
  }

  list(limit: number): SmbRecentRow[] {
    return this.#db
      .prepare('SELECT path, at FROM smb_recent ORDER BY at DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ path: String(row['path']), at: String(row['at']) }));
  }
}
