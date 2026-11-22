/**
 * Contratos de la API v1 (base `/api/v1`). Un único esquema TypeBox sirve para validar en el
 * servidor (Fastify/ajv) y para los tipos de TypeScript del cliente (ADR-0012).
 *
 * Las rutas de ficheros son relativas a la raíz administrada, con `/` como separador
 * (`/` = raíz; `/Proyectos/Web`). Nunca son rutas del sistema del servidor.
 */

import { Type, type Static } from 'typebox';

const ClientPath = Type.String({ maxLength: 4096 });
const Username = Type.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' });

// ── Sesión y configuración inicial ──────────────────────────────────────────────────────────

export const Credentials = Type.Object(
  { username: Username, password: Type.String({ minLength: 1, maxLength: 1024 }) },
  { additionalProperties: false },
);
export type Credentials = Static<typeof Credentials>;

export const SetupOwnerRequest = Type.Object(
  {
    token: Type.String({ minLength: 8, maxLength: 128 }),
    username: Username,
    password: Type.String({ minLength: 12, maxLength: 1024 }),
  },
  { additionalProperties: false },
);
export type SetupOwnerRequest = Static<typeof SetupOwnerRequest>;

export const SessionUser = Type.Object({
  username: Type.String(),
  role: Type.Union([Type.Literal('owner'), Type.Literal('user')]),
});
export type SessionUser = Static<typeof SessionUser>;

export const SetupStatus = Type.Object({
  needsOwner: Type.Boolean(),
  /** Nombre mDNS del servidor (p. ej. «mi-nube.local»): las llaves de acceso necesitan abrirlo por nombre. */
  localName: Type.String(),
});
export type SetupStatus = Static<typeof SetupStatus>;

// ── Sistema ─────────────────────────────────────────────────────────────────────────────────

export const HealthResponse = Type.Object({
  status: Type.Literal('ok'),
  time: Type.String(),
  volumeState: Type.String(),
  /** Nombre de la release en ejecución (release.json); null en desarrollo. */
  release: Type.Union([Type.String(), Type.Null()]),
  /** Versión de la aplicación («0.2.0»): la de package.json con la que se compiló. */
  version: Type.Union([Type.String(), Type.Null()]),
});
export type HealthResponse = Static<typeof HealthResponse>;

/** Espacio del volumen en bytes; null si el volumen no es legible. */
export const VolumeSpace = Type.Object({
  totalBytes: Type.Number(),
  freeBytes: Type.Number(),
  reservedBytes: Type.Number(),
});
export type VolumeSpace = Static<typeof VolumeSpace>;

// ── Explorador ──────────────────────────────────────────────────────────────────────────────

export const FsEntry = Type.Object({
  name: Type.String(),
  type: Type.Union([Type.Literal('dir'), Type.Literal('file')]),
  /** Bytes; 0 en directorios. */
  size: Type.Number(),
  /** ISO 8601. */
  mtime: Type.String(),
  /** false si el nombre no es válido en Windows/macOS o colisiona por mayúsculas: se trata como solo lectura. */
  portable: Type.Boolean(),
  issue: Type.Optional(Type.String()),
});
export type FsEntry = Static<typeof FsEntry>;

export const FsListQuery = Type.Object(
  {
    path: ClientPath,
    cursor: Type.Optional(Type.String({ pattern: '^[0-9]{1,9}$' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  },
  { additionalProperties: false },
);
export type FsListQuery = Static<typeof FsListQuery>;

export const FsListResponse = Type.Object({
  path: Type.String(),
  entries: Type.Array(FsEntry),
  total: Type.Integer(),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type FsListResponse = Static<typeof FsListResponse>;

export const CreateFolderRequest = Type.Object(
  { path: ClientPath, name: Type.String({ minLength: 1, maxLength: 255 }) },
  { additionalProperties: false },
);
export type CreateFolderRequest = Static<typeof CreateFolderRequest>;

export const PathResponse = Type.Object({ path: Type.String(), name: Type.String() });
export type PathResponse = Static<typeof PathResponse>;

/** Lo último subido o creado que SIGUE existiendo (Panel → Recientes). */
export const RecentEntry = Type.Object({
  path: Type.String(),
  /** Carpeta que lo contiene. */
  dir: Type.String(),
  name: Type.String(),
  type: Type.Union([Type.Literal('dir'), Type.Literal('file')]),
  size: Type.Number(),
  mtime: Type.String(),
  /** Cuándo se subió o creó (registro de actividad). */
  at: Type.String(),
});
export type RecentEntry = Static<typeof RecentEntry>;

export const RecentQuery = Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 48 })) }, { additionalProperties: false });
export type RecentQuery = Static<typeof RecentQuery>;

export const RecentResponse = Type.Object({ entries: Type.Array(RecentEntry) });
export type RecentResponse = Static<typeof RecentResponse>;

export const DownloadQuery = Type.Object(
  {
    path: ClientPath,
    /** 1 = mostrar en el navegador (solo tipos seguros: imagen, audio, vídeo, PDF, texto). */
    inline: Type.Optional(Type.Union([Type.Literal('1'), Type.Literal('0')])),
  },
  { additionalProperties: false },
);
export type DownloadQuery = Static<typeof DownloadQuery>;

// ── Operaciones sobre archivos y carpetas ───────────────────────────────────────────────────

const Name = Type.String({ minLength: 1, maxLength: 255 });
/** Máximo de elementos por operación en lote. */
export const MAX_BATCH_ITEMS = 1000;
const PathList = Type.Array(ClientPath, { minItems: 1, maxItems: MAX_BATCH_ITEMS });

/** Crear un archivo vacío (p. ej. «Nuevo documento de texto.txt»). */
export const CreateFileRequest = Type.Object({ path: ClientPath, name: Name }, { additionalProperties: false });
export type CreateFileRequest = Static<typeof CreateFileRequest>;

/** Renombrar dentro de la misma carpeta. Nunca sobrescribe: si el nombre existe, 409. */
export const RenameRequest = Type.Object({ path: ClientPath, name: Name }, { additionalProperties: false });
export type RenameRequest = Static<typeof RenameRequest>;

/** Mover o copiar a una carpeta. Si el nombre existe en el destino se usa «nombre (2)». */
export const TransferItemsRequest = Type.Object({ paths: PathList, destination: ClientPath }, { additionalProperties: false });
export type TransferItemsRequest = Static<typeof TransferItemsRequest>;

/** Tamaño total de carpetas y archivos (panel de detalles), contando todo su contenido. */
export const FsSizeRequest = Type.Object({ paths: PathList }, { additionalProperties: false });
export type FsSizeRequest = Static<typeof FsSizeRequest>;

export const FsSizeResponse = Type.Object({
  /** Suma de los archivos encontrados. */
  bytes: Type.Number(),
  files: Type.Integer(),
  /** Subcarpetas encontradas (sin contar las pedidas). */
  folders: Type.Integer(),
  /** false si se cortó por tiempo o por número de elementos: los totales son un mínimo. */
  complete: Type.Boolean(),
});
export type FsSizeResponse = Static<typeof FsSizeResponse>;

/** Enviar a la papelera (recuperable). */
export const TrashItemsRequest = Type.Object({ paths: PathList }, { additionalProperties: false });
export type TrashItemsRequest = Static<typeof TrashItemsRequest>;

/** Resultado por elemento de una operación en lote: un fallo no deshace los anteriores. */
export const ItemResult = Type.Union([
  Type.Object({ from: Type.String(), ok: Type.Literal(true), path: Type.String(), name: Type.String() }),
  Type.Object({ from: Type.String(), ok: Type.Literal(false), code: Type.String(), message: Type.String() }),
]);
export type ItemResult = Static<typeof ItemResult>;

export const BatchResponse = Type.Object({ results: Type.Array(ItemResult) });
export type BatchResponse = Static<typeof BatchResponse>;

/** Descarga ZIP: carpeta completa (`names` ausente) o elementos de una carpeta separados por «/». */
export const ZipQuery = Type.Object(
  { dir: ClientPath, names: Type.Optional(Type.String({ maxLength: 262144 })) },
  { additionalProperties: false },
);
export type ZipQuery = Static<typeof ZipQuery>;

// ── Papelera ────────────────────────────────────────────────────────────────────────────────

const TrashId = Type.String({ pattern: '^[0-9]{13}-[0-9a-f]{8}$' });

export const TrashEntry = Type.Object({
  id: Type.String(),
  name: Type.String(),
  /** Ruta que tenía antes de eliminarse; null si se desconoce (metadatos dañados). */
  originalPath: Type.Union([Type.String(), Type.Null()]),
  type: Type.Union([Type.Literal('dir'), Type.Literal('file')]),
  /** Bytes (archivos) o suma de su contenido (carpetas). */
  size: Type.Number(),
  deletedAt: Type.String(),
  /** Fecha a partir de la cual se elimina definitivamente de forma automática. */
  expiresAt: Type.Union([Type.String(), Type.Null()]),
});
export type TrashEntry = Static<typeof TrashEntry>;

export const TrashListResponse = Type.Object({
  entries: Type.Array(TrashEntry),
  totalBytes: Type.Number(),
  retentionDays: Type.Union([Type.Integer(), Type.Null()]),
});
export type TrashListResponse = Static<typeof TrashListResponse>;

export const TrashIdsRequest = Type.Object(
  { ids: Type.Array(TrashId, { minItems: 1, maxItems: MAX_BATCH_ITEMS }) },
  { additionalProperties: false },
);
export type TrashIdsRequest = Static<typeof TrashIdsRequest>;

export const TrashPurgeResponse = Type.Object({ removed: Type.Integer() });
export type TrashPurgeResponse = Static<typeof TrashPurgeResponse>;

// ── Subidas reanudables (ADR-0010) ──────────────────────────────────────────────────────────

/** Tipo de contenido de los bloques enviados con PATCH. */
export const UPLOAD_CONTENT_TYPE = 'application/offset+octet-stream';
/** Cabecera con el offset (petición y respuesta) y con el tamaño total (respuesta de HEAD). */
export const UPLOAD_OFFSET_HEADER = 'upload-offset';
export const UPLOAD_LENGTH_HEADER = 'upload-length';
/** Cabecera obligatoria en toda petición que modifica estado (protección CSRF junto con SameSite). */
export const CSRF_HEADER = 'x-pcloud-request';

export const UploadInitRequest = Type.Object(
  {
    path: ClientPath,
    name: Type.String({ minLength: 1, maxLength: 255 }),
    size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sha256: Type.Optional(Type.String({ pattern: '^[0-9a-f]{64}$' })),
  },
  { additionalProperties: false },
);
export type UploadInitRequest = Static<typeof UploadInitRequest>;

export const UploadInitResponse = Type.Object({
  id: Type.String(),
  offset: Type.Integer(),
  /** Tamaño de bloque recomendado y máximo admitido por petición, en bytes. */
  chunkSize: Type.Integer(),
  maxChunkSize: Type.Integer(),
});
export type UploadInitResponse = Static<typeof UploadInitResponse>;

export const UploadParams = Type.Object({ id: Type.String({ pattern: '^[0-9a-f-]{36}$' }) });
export type UploadParams = Static<typeof UploadParams>;

export const UploadCompleteResponse = Type.Object({
  /** Ruta final (puede diferir del nombre pedido si ya existía: nunca se sobrescribe). */
  path: Type.String(),
  name: Type.String(),
  size: Type.Number(),
});
export type UploadCompleteResponse = Static<typeof UploadCompleteResponse>;
