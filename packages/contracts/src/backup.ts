/**
 * Contratos de la copia de seguridad en un disco USB externo (ADR-0017).
 *
 * El servidor devuelve códigos, nunca frases: la web los traduce. Así el estado se puede mostrar
 * en cualquier idioma y las pruebas comparan valores estables.
 */

import { Type, type Static } from 'typebox';

const FsUuid = Type.String({ minLength: 4, maxLength: 36, pattern: '^[0-9A-Fa-f-]+$' });

/** Un disco conectado que no es el de la nube ni el del sistema. */
export const BackupDiskView = Type.Object({
  uuid: Type.String(),
  /** exfat | ntfs (compatibles) o el tipo real si no lo es (vfat, ext4…). */
  fsType: Type.String(),
  compatible: Type.Boolean(),
  sizeBytes: Type.Number(),
  label: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  /** Es el disco asignado como copia de seguridad. */
  assigned: Type.Boolean(),
  /** Cuándo se detectó conectado (cada reconexión es una fecha nueva). */
  connectedAt: Type.String(),
});
export type BackupDiskView = Static<typeof BackupDiskView>;

export const BackupAssignedView = Type.Object({
  uuid: Type.String(),
  label: Type.Union([Type.String(), Type.Null()]),
  model: Type.Union([Type.String(), Type.Null()]),
  sizeBytes: Type.Number(),
  assignedAt: Type.String(),
});
export type BackupAssignedView = Static<typeof BackupAssignedView>;

export const BACKUP_PHASES = ['idle', 'mounting', 'scanning', 'confirm', 'copying', 'finishing', 'ejecting'] as const;
export type BackupPhase = (typeof BACKUP_PHASES)[number];

export const BackupProgress = Type.Object({
  filesTotal: Type.Number(),
  filesDone: Type.Number(),
  bytesTotal: Type.Number(),
  bytesDone: Type.Number(),
  /** Ruta (relativa a la nube) del archivo que se está copiando. */
  current: Type.Union([Type.String(), Type.Null()]),
  bytesPerSecond: Type.Number(),
});
export type BackupProgress = Static<typeof BackupProgress>;

/** Lo que hará (o hizo) una sincronización. */
export const BackupPlanSummary = Type.Object({
  newFiles: Type.Number(),
  changedFiles: Type.Number(),
  /** Archivos que ya no están en la nube: se apartan al archivo de la copia, nunca se borran. */
  removedFiles: Type.Number(),
  unchangedFiles: Type.Number(),
  bytesToCopy: Type.Number(),
});
export type BackupPlanSummary = Static<typeof BackupPlanSummary>;

/**
 * Resultado de una sincronización:
 *  - ok / ok_with_errors: terminada (con algunos archivos que no se pudieron copiar);
 *  - cancelled: la paró el usuario; lo copiado se queda y la próxima vez continúa;
 *  - failed: se interrumpió (disco desconectado, sin espacio…). `error` dice por qué.
 */
export const BackupRunView = Type.Object({
  id: Type.Number(),
  startedAt: Type.String(),
  finishedAt: Type.Union([Type.String(), Type.Null()]),
  result: Type.Union([Type.Literal('ok'), Type.Literal('ok_with_errors'), Type.Literal('cancelled'), Type.Literal('failed'), Type.Literal('running')]),
  error: Type.Union([Type.String(), Type.Null()]),
  summary: BackupPlanSummary,
  bytesCopied: Type.Number(),
  failedFiles: Type.Number(),
});
export type BackupRunView = Static<typeof BackupRunView>;

/**
 * Códigos de problema (la web los traduce):
 *  AGENT_UNAVAILABLE   el servicio que monta discos no está instalado o no responde
 *  DISK_NOT_CONNECTED  el disco asignado no está conectado
 *  DISK_MISMATCH       el disco tiene el mismo UUID pero otra marca de copia
 *  SOURCE_UNAVAILABLE  el disco de la nube no está listo
 *  SOURCE_EMPTY        la nube aparece vacía y la copia no: no se sincroniza sin confirmar
 *  NO_SPACE            no cabe en el disco de copia
 *  MOUNT_FAILED        no se pudo montar (suele ser un disco con errores: revisarlo en un PC)
 *  DISK_REMOVED        se desconectó durante la copia
 *  READ_ONLY           el disco de copia está en solo lectura (errores en el sistema de archivos)
 */
export const BackupStatusResponse = Type.Object({
  phase: Type.Union([
    Type.Literal('idle'),
    Type.Literal('mounting'),
    Type.Literal('scanning'),
    Type.Literal('confirm'),
    Type.Literal('copying'),
    Type.Literal('finishing'),
    Type.Literal('ejecting'),
  ]),
  assigned: Type.Union([BackupAssignedView, Type.Null()]),
  /** Discos externos conectados ahora mismo (sin el de la nube ni el del sistema). */
  disks: Type.Array(BackupDiskView),
  /** El disco asignado está conectado. */
  assignedConnected: Type.Boolean(),
  /** Sincronizar sola al conectar el disco asignado, sin preguntar. */
  autoSync: Type.Boolean(),
  /** Días que se guardan los archivos borrados o sustituidos en la copia. */
  retentionDays: Type.Number(),
  progress: Type.Union([BackupProgress, Type.Null()]),
  /** Plan pendiente de confirmar (fase `confirm`): muchos borrados o la nube vacía. */
  pendingPlan: Type.Union([BackupPlanSummary, Type.Null()]),
  lastRun: Type.Union([BackupRunView, Type.Null()]),
  /** Última sincronización correcta (aunque la última ejecución fallase). */
  lastSuccessAt: Type.Union([Type.String(), Type.Null()]),
  problem: Type.Union([Type.String(), Type.Null()]),
  /** El servicio de montaje (root) está instalado. */
  agentReady: Type.Boolean(),
});
export type BackupStatusResponse = Static<typeof BackupStatusResponse>;

export const BackupAssignRequest = Type.Object({ uuid: FsUuid }, { additionalProperties: false });
export type BackupAssignRequest = Static<typeof BackupAssignRequest>;

export const BackupStartRequest = Type.Object({ confirm: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export type BackupStartRequest = Static<typeof BackupStartRequest>;

export const BackupSettingsRequest = Type.Object(
  { autoSync: Type.Optional(Type.Boolean()), retentionDays: Type.Optional(Type.Integer({ minimum: 7, maximum: 3650 })) },
  { additionalProperties: false },
);
export type BackupSettingsRequest = Static<typeof BackupSettingsRequest>;

export const BackupHistoryResponse = Type.Object({ runs: Type.Array(BackupRunView) });
export type BackupHistoryResponse = Static<typeof BackupHistoryResponse>;
