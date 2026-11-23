/**
 * Favoritos (ADR-0027): carpetas y archivos marcados con la estrella, por usuario. Se guardan en
 * la base de datos (microSD), nunca en el disco de datos, y siguen al elemento al renombrarlo o
 * moverlo desde la web.
 */

import { Type, type Static } from 'typebox';

/** Máximo de favoritos por usuario. */
export const MAX_FAVORITES = 500;

export const FavoriteEntry = Type.Object({
  path: Type.String(),
  /** Carpeta que lo contiene. */
  dir: Type.String(),
  name: Type.String(),
  type: Type.Union([Type.Literal('dir'), Type.Literal('file')]),
  /** Bytes (archivos); 0 en carpetas o si no se pudo mirar. */
  size: Type.Number(),
  /** ISO 8601; null si no se pudo mirar. */
  mtime: Type.Union([Type.String(), Type.Null()]),
  /** Cuándo se marcó como favorito. */
  addedAt: Type.String(),
  /**
   * true = existe en esa ruta; false = ya no está ahí (eliminado, en la papelera o cambiado desde
   * la carpeta de red); null = el disco no se puede leer ahora. Nunca se quita solo de la lista.
   */
  exists: Type.Union([Type.Boolean(), Type.Null()]),
});
export type FavoriteEntry = Static<typeof FavoriteEntry>;

export const FavoriteListResponse = Type.Object({
  /** En el orden personalizado (lo nuevo entra al principio). */
  entries: Type.Array(FavoriteEntry),
  max: Type.Integer(),
});
export type FavoriteListResponse = Static<typeof FavoriteListResponse>;

/** Añadir, quitar o reordenar favoritos (en el orden, la lista en el orden nuevo). */
export const FavoritePathsRequest = Type.Object(
  { paths: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: MAX_FAVORITES }) },
  { additionalProperties: false },
);
export type FavoritePathsRequest = Static<typeof FavoritePathsRequest>;
