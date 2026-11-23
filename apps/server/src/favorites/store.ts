/**
 * Favoritos (ADR-0027): persistencia en SQLite, por usuario.
 *
 * - Solo se guarda la ruta del cliente y si era carpeta o archivo: nada aquí toca el disco de datos.
 * - Renombrar o mover desde la web reescribe la ruta (storage/relocate.ts).
 * - Que la ruta no exista ahora NO borra el favorito (mandato del disco: una ausencia nunca es un
 *   borrado). Al restaurarlo de la papelera, vuelve a verse; si no, la persona lo quita.
 */

import { MAX_FAVORITES } from '@pcloud/contracts';
import { transaction, type Db } from '../db/database.ts';
import { AppError } from '../errors.ts';

export interface FavoriteRow {
  readonly path: string;
  readonly kind: 'file' | 'dir';
  readonly createdAt: string;
}

export interface NewFavorite {
  readonly path: string;
  readonly kind: 'file' | 'dir';
}

export class FavoriteStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** En el orden personalizado (lo nuevo entra al principio). */
  list(userId: number): FavoriteRow[] {
    return this.#db
      .prepare('SELECT path, kind, created_at FROM favorites WHERE user_id = ? ORDER BY position, created_at DESC, rowid DESC LIMIT ?')
      .all(userId, MAX_FAVORITES)
      .map((row) => ({ path: String(row['path']), kind: row['kind'] === 'dir' ? 'dir' : 'file', createdAt: String(row['created_at']) }));
  }

  /**
   * Añade los que falten (los que ya eran favoritos conservan su fecha; si cambió de tipo, se
   * corrige). Todo o nada: si se pasaría del máximo, no añade ninguno.
   */
  add(userId: number, items: readonly NewFavorite[], now: Date): number {
    return transaction(this.#db, () => {
      const existing = new Set(this.list(userId).map((row) => row.path));
      const fresh = [...new Map(items.filter((item) => !existing.has(item.path)).map((item) => [item.path, item])).values()];
      if (existing.size + fresh.length > MAX_FAVORITES) {
        throw new AppError('CONFLICT', 'Has llegado al máximo de favoritos: quita alguno antes de añadir más');
      }
      const insert = this.#db.prepare(
        `INSERT INTO favorites (user_id, path, kind, created_at, position) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, path) DO UPDATE SET kind = excluded.kind`,
      );
      // Lo nuevo entra al principio del orden personalizado; dentro de un lote, el último primero
      // (como se ve en la web nada más añadirlo).
      const first = Number(this.#db.prepare('SELECT COALESCE(MIN(position), 0) AS first FROM favorites WHERE user_id = ?').get(userId)?.['first'] ?? 0);
      const at = now.toISOString();
      items.forEach((item, index) => insert.run(userId, item.path, item.kind, at, first - 1 - index));
      return fresh.length;
    });
  }

  /** Nuevo orden: las rutas indicadas primero, en ese orden; las que no se nombran, detrás como estaban. */
  reorder(userId: number, paths: readonly string[]): void {
    transaction(this.#db, () => {
      const current = this.list(userId).map((row) => row.path);
      const known = new Set(current);
      const wanted = [...new Set(paths)].filter((p) => known.has(p));
      const named = new Set(wanted);
      const order = [...wanted, ...current.filter((p) => !named.has(p))];
      const update = this.#db.prepare('UPDATE favorites SET position = ? WHERE user_id = ? AND path = ?');
      order.forEach((p, index) => update.run(index, userId, p));
    });
  }

  remove(userId: number, paths: readonly string[]): number {
    return transaction(this.#db, () => {
      const remove = this.#db.prepare('DELETE FROM favorites WHERE user_id = ? AND path = ?');
      let removed = 0;
      for (const p of new Set(paths)) removed += Number(remove.run(userId, p).changes);
      return removed;
    });
  }
}
