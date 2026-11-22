/**
 * Rutas guardadas en la base de datos que siguen a un elemento cuando se renombra o se mueve.
 *
 * Los enlaces para compartir (`shares.path`), las subidas en curso (`uploads.dir_path`) y los
 * favoritos (`favorites.path`, ADR-0027) guardan la ruta del cliente. Sin esto, renombrar o mover
 * una carpeta deja el enlace del invitado en «no encontrado», la subida falla al confirmarse
 * porque su carpeta de destino ya no existe y el favorito deja de encontrarse.
 *
 * Se llama desde FsOperations dentro de la cola serie, justo después del rename en disco: el
 * commit de una subida va por la misma cola, así que nunca ve la ruta antigua con el disco ya
 * cambiado. Solo se tocan las subidas que siguen recibiendo datos; las que están confirmándose
 * o terminadas guardan su ruta final y no deben cambiar.
 */

import { transaction, type Db } from '../db/database.ts';
import { formatClientPath, parseClientPath } from './paths.ts';

/** Sustituye el prefijo `from` por `to` en una ruta del cliente (ruta exacta o algo de dentro). */
const REBASE = (column: string): string =>
  `${column} = ? || substr(${column}, length(?) + 1)
   WHERE (${column} = ? OR substr(${column}, 1, length(?) + 1) = ? || '/')`;

export interface RelocateResult {
  readonly shares: number;
  readonly uploads: number;
  readonly favorites: number;
}

export function relocatePaths(db: Db, fromPath: string, toPath: string): RelocateResult {
  const from = formatClientPath(parseClientPath(fromPath));
  const to = formatClientPath(parseClientPath(toPath));
  if (from === to || from === '/') return { shares: 0, uploads: 0, favorites: 0 };
  const args = [to, from, from, from, from] as const;
  return transaction(db, () => ({
    shares: Number(db.prepare(`UPDATE shares SET ${REBASE('path')}`).run(...args).changes),
    uploads: Number(db.prepare(`UPDATE uploads SET ${REBASE('dir_path')} AND state = 'receiving'`).run(...args).changes),
    // OR REPLACE: un favorito antiguo que apuntaba a la ruta de destino (algo que ya no estaba
    // ahí: el rename nunca sobrescribe) cede su sitio al elemento que llega.
    favorites: Number(db.prepare(`UPDATE OR REPLACE favorites SET ${REBASE('path')}`).run(...args).changes),
  }));
}
