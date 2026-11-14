/**
 * Contratos de cuenta, seguridad, actividad, llaves de acceso (passkeys) y visores.
 */

import { Type, type Static } from 'typebox';

const Username = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' });
const Password = Type.String({ minLength: 12, maxLength: 1024 });
const B64Url = Type.String({ minLength: 1, maxLength: 65536, pattern: '^[A-Za-z0-9_-]+$' });

// ── Cuenta y sesiones ───────────────────────────────────────────────────────────────────────

export const ChangePasswordRequest = Type.Object(
  { currentPassword: Type.String({ minLength: 1, maxLength: 1024 }), newPassword: Password, signOutOthers: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);
export type ChangePasswordRequest = Static<typeof ChangePasswordRequest>;

export const SessionView = Type.Object({
  id: Type.String(),
  current: Type.Boolean(),
  createdAt: Type.String(),
  lastSeenAt: Type.String(),
  ip: Type.Union([Type.String(), Type.Null()]),
  userAgent: Type.Union([Type.String(), Type.Null()]),
});
export type SessionView = Static<typeof SessionView>;

export const SessionListResponse = Type.Object({ sessions: Type.Array(SessionView) });
export type SessionListResponse = Static<typeof SessionListResponse>;

export const IdParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 1024, pattern: '^[A-Za-z0-9_-]+$' }) });
export type IdParams = Static<typeof IdParams>;

// ── Usuarios (solo propietario) ─────────────────────────────────────────────────────────────

export const UserView = Type.Object({
  id: Type.Integer(),
  username: Type.String(),
  role: Type.Union([Type.Literal('owner'), Type.Literal('user')]),
  createdAt: Type.String(),
  disabled: Type.Boolean(),
  passkeys: Type.Integer(),
});
export type UserView = Static<typeof UserView>;

export const UserListResponse = Type.Object({ users: Type.Array(UserView) });
export type UserListResponse = Static<typeof UserListResponse>;

export const CreateUserRequest = Type.Object(
  { username: Username, password: Password, role: Type.Union([Type.Literal('owner'), Type.Literal('user')]) },
  { additionalProperties: false },
);
export type CreateUserRequest = Static<typeof CreateUserRequest>;

export const ResetPasswordRequest = Type.Object({ password: Password }, { additionalProperties: false });
export type ResetPasswordRequest = Static<typeof ResetPasswordRequest>;

export const UserIdParams = Type.Object({ id: Type.Integer({ minimum: 1 }) });
export type UserIdParams = Static<typeof UserIdParams>;

// ── Actividad ───────────────────────────────────────────────────────────────────────────────

export const ActivityQuery = Type.Object(
  {
    before: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    /** Prefijo de acción: «fs.», «auth.», «trash.»… */
    action: Type.Optional(Type.String({ maxLength: 40, pattern: '^[a-z.]+$' })),
  },
  { additionalProperties: false },
);
export type ActivityQuery = Static<typeof ActivityQuery>;

export const ActivityEntry = Type.Object({
  id: Type.Integer(),
  at: Type.String(),
  username: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  path: Type.Union([Type.String(), Type.Null()]),
  result: Type.String(),
  ip: Type.Union([Type.String(), Type.Null()]),
  detail: Type.Union([Type.String(), Type.Null()]),
});
export type ActivityEntry = Static<typeof ActivityEntry>;

export const ActivityResponse = Type.Object({ entries: Type.Array(ActivityEntry), nextBefore: Type.Union([Type.Integer(), Type.Null()]) });
export type ActivityResponse = Static<typeof ActivityResponse>;

// ── Llaves de acceso (WebAuthn) ─────────────────────────────────────────────────────────────

export const PasskeyView = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
});
export type PasskeyView = Static<typeof PasskeyView>;

export const PasskeyListResponse = Type.Object({ passkeys: Type.Array(PasskeyView) });
export type PasskeyListResponse = Static<typeof PasskeyListResponse>;

/** Añadir una llave exige confirmar la contraseña (una sesión robada no basta para persistir). */
export const PasskeyRegisterOptionsRequest = Type.Object({ password: Type.String({ minLength: 1, maxLength: 1024 }) }, { additionalProperties: false });
export type PasskeyRegisterOptionsRequest = Static<typeof PasskeyRegisterOptionsRequest>;

/** Opciones para navigator.credentials.create() (binarios en base64url). */
export const PasskeyRegisterOptions = Type.Object({
  challenge: Type.String(),
  rp: Type.Object({ id: Type.String(), name: Type.String() }),
  user: Type.Object({ id: Type.String(), name: Type.String(), displayName: Type.String() }),
  pubKeyCredParams: Type.Array(Type.Object({ type: Type.Literal('public-key'), alg: Type.Integer() })),
  excludeCredentials: Type.Array(Type.Object({ type: Type.Literal('public-key'), id: Type.String() })),
  timeout: Type.Integer(),
});
export type PasskeyRegisterOptions = Static<typeof PasskeyRegisterOptions>;

export const PasskeyRegisterRequest = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 64 }),
    id: B64Url,
    clientDataJSON: B64Url,
    attestationObject: B64Url,
  },
  { additionalProperties: false },
);
export type PasskeyRegisterRequest = Static<typeof PasskeyRegisterRequest>;

/** Opciones para navigator.credentials.get() (llaves detectables: sin lista de credenciales). */
export const PasskeyLoginOptions = Type.Object({ challenge: Type.String(), rpId: Type.String(), timeout: Type.Integer() });
export type PasskeyLoginOptions = Static<typeof PasskeyLoginOptions>;

export const PasskeyLoginRequest = Type.Object(
  { id: B64Url, clientDataJSON: B64Url, authenticatorData: B64Url, signature: B64Url, userHandle: Type.Optional(Type.String({ maxLength: 1024 })) },
  { additionalProperties: false },
);
export type PasskeyLoginRequest = Static<typeof PasskeyLoginRequest>;

export const RenamePasskeyRequest = Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false });
export type RenamePasskeyRequest = Static<typeof RenamePasskeyRequest>;

// ── Errores del cliente (diagnóstico local) ────────────────────────────────────────────────

/** Error de JavaScript del navegador, para diagnosticar fallos que solo ocurren en un dispositivo. */
export const ClientErrorReport = Type.Object(
  {
    message: Type.String({ maxLength: 1000 }),
    stack: Type.Optional(Type.String({ maxLength: 4000 })),
    route: Type.String({ maxLength: 300 }),
    standalone: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type ClientErrorReport = Static<typeof ClientErrorReport>;

// ── Velocidad del disco ─────────────────────────────────────────────────────────────────────

export const DiskSpeedResponse = Type.Object({
  /** Escritura secuencial (MB/s, decimal), con fsync incluido. */
  writeMBps: Type.Number(),
  /** Lectura secuencial (MB/s) sin caché de memoria. */
  readMBps: Type.Number(),
  /** Lecturas aleatorias de 4 KiB por segundo. */
  randomReadIops: Type.Number(),
  sizeMB: Type.Number(),
  durationMs: Type.Number(),
  testedAt: Type.String(),
});
export type DiskSpeedResponse = Static<typeof DiskSpeedResponse>;

// ── Visores y multimedia ────────────────────────────────────────────────────────────────────

export const MediaCapabilities = Type.Object({
  ffmpeg: Type.Boolean(),
  office: Type.Boolean(),
  hardwareVideo: Type.Boolean(),
});
export type MediaCapabilities = Static<typeof MediaCapabilities>;

export const MediaInfoResponse = Type.Object({
  duration: Type.Union([Type.Number(), Type.Null()]),
  container: Type.Union([Type.String(), Type.Null()]),
  video: Type.Union([Type.Object({ codec: Type.String(), width: Type.Integer(), height: Type.Integer() }), Type.Null()]),
  audio: Type.Union([Type.Object({ codec: Type.String(), channels: Type.Integer() }), Type.Null()]),
  /** direct: el navegador lo reproduce tal cual · remux/transcode: flujo convertido por la Pi. */
  playback: Type.Union([Type.Literal('direct'), Type.Literal('remux'), Type.Literal('transcode'), Type.Literal('none')]),
});
export type MediaInfoResponse = Static<typeof MediaInfoResponse>;

/** `v`: versión del archivo (fecha de modificación) para que el navegador no use una vista previa antigua. */
export const MediaPathQuery = Type.Object({ path: Type.String({ maxLength: 4096 }), v: Type.Optional(Type.String({ maxLength: 64 })) }, { additionalProperties: false });
export type MediaPathQuery = Static<typeof MediaPathQuery>;

export const MediaStreamQuery = Type.Object(
  { path: Type.String({ maxLength: 4096 }), t: Type.Optional(Type.Number({ minimum: 0, maximum: 1e7 })) },
  { additionalProperties: false },
);
export type MediaStreamQuery = Static<typeof MediaStreamQuery>;

export const ThumbQuery = Type.Object(
  { path: Type.String({ maxLength: 4096 }), size: Type.Optional(Type.Integer({ minimum: 64, maximum: 1024 })), v: Type.Optional(Type.String({ maxLength: 64 })) },
  { additionalProperties: false },
);
export type ThumbQuery = Static<typeof ThumbQuery>;
