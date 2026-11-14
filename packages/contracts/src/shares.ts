/**
 * Enlaces para compartir con personas sin cuenta (ADR-0018).
 *
 * El propietario crea un enlace de SOLO LECTURA a un archivo o carpeta, con caducidad obligatoria
 * y, si quiere, contraseña y límite de descargas. El enlace se abre desde Internet por la «puerta
 * de invitados» (un servidor aparte que solo sabe servir esos enlaces, publicado con Tailscale
 * Funnel solo mientras haya enlaces activos). El servidor devuelve códigos; la web los traduce.
 */

import { Type, type Static } from 'typebox';

const ClientPath = Type.String({ minLength: 1, maxLength: 4096 });

export const SHARE_EXPIRY_DAYS = [1, 7, 30] as const;
export const SHARE_MAX_DOWNLOADS = [1, 3, 10] as const;
export const SHARE_PASSWORD_MIN = 4;

export const ShareCreateRequest = Type.Object(
  {
    path: ClientPath,
    expiresInDays: Type.Union([Type.Literal(1), Type.Literal(7), Type.Literal(30)]),
    password: Type.Optional(Type.String({ minLength: SHARE_PASSWORD_MIN, maxLength: 128 })),
    maxDownloads: Type.Optional(Type.Union([Type.Literal(1), Type.Literal(3), Type.Literal(10)])),
  },
  { additionalProperties: false },
);
export type ShareCreateRequest = Static<typeof ShareCreateRequest>;

export const ShareParams = Type.Object({ id: Type.String({ pattern: '^[a-z0-9]{12}$' }) }, { additionalProperties: false });
export type ShareParams = Static<typeof ShareParams>;

/** active | expired (pasó la fecha) | exhausted (sin descargas restantes) | revoked. */
export const SHARE_STATES = ['active', 'expired', 'exhausted', 'revoked'] as const;
export type ShareState = (typeof SHARE_STATES)[number];

export const ShareView = Type.Object({
  id: Type.String(),
  path: Type.String(),
  name: Type.String(),
  kind: Type.Union([Type.Literal('file'), Type.Literal('dir')]),
  state: Type.Union([Type.Literal('active'), Type.Literal('expired'), Type.Literal('exhausted'), Type.Literal('revoked')]),
  createdAt: Type.String(),
  expiresAt: Type.String(),
  hasPassword: Type.Boolean(),
  maxDownloads: Type.Union([Type.Number(), Type.Null()]),
  downloads: Type.Number(),
  bytesSent: Type.Number(),
  lastAccessAt: Type.Union([Type.String(), Type.Null()]),
});
export type ShareView = Static<typeof ShareView>;

/**
 * Estado de la puerta de invitados:
 *  - off: no hay enlaces activos, nada publicado en Internet;
 *  - starting: publicándose;
 *  - on: publicada en `url`;
 *  - needs_funnel: hay que permitir Funnel una vez en la cuenta de Tailscale (`enableUrl`);
 *  - needs_https: hay que activar «HTTPS Certificates» en la consola de Tailscale;
 *  - no_tailscale: Tailscale no está instalado o no ha iniciado sesión;
 *  - unavailable: el agente no está instalado (pcloud-install-share.sh);
 *  - error: falló por otro motivo (se reintenta solo).
 */
export const GATEWAY_STATES = ['off', 'starting', 'on', 'needs_funnel', 'needs_https', 'no_tailscale', 'unavailable', 'error'] as const;
export type GatewayState = (typeof GATEWAY_STATES)[number];

export interface GatewayView {
  readonly state: GatewayState;
  readonly url: string | null;
  readonly enableUrl: string | null;
  readonly checkedAt: string | null;
}

export interface ShareListResponse {
  readonly shares: readonly ShareView[];
  readonly gateway: GatewayView;
}

export interface ShareCreateResponse {
  readonly share: ShareView;
  /** El token en claro SOLO se devuelve al crear: en la base se guarda su hash. */
  readonly token: string;
  readonly gateway: GatewayView;
}
