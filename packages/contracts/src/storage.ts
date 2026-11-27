/**
 * Estado del volumen de datos (HDD) tal como lo expone `GET /api/v1/system/storage`.
 *
 * Ver docs/STORAGE_CONTRACT.md y docs/adr/0003-modelo-estados-volumen.md.
 * Solo sintaxis "borrable" (sin enum/namespace): el servidor ejecuta TypeScript
 * directamente con el type stripping nativo de Node (ADR-0001).
 */

export const VOLUME_STATES = [
  /** Aún no ha terminado la primera comprobación. */
  'INITIALIZING',
  /** Montado, identificado y escribible. ÚNICO estado que admite mutaciones. */
  'READY',
  /** Volumen correcto pero en solo lectura (montaje `ro`, `errors=remount-ro`, EROFS). */
  'READ_ONLY',
  /** No montado, dispositivo ausente o estado indeterminable. */
  'UNAVAILABLE',
  /** Hay algo montado, pero no es el volumen vinculado (UUID o marcador). */
  'WRONG_VOLUME',
  /** Volumen esperado que requiere intervención humana (onboarding, marcador, opciones). */
  'NEEDS_CHECK',
  /** Errores de E/S al comprobar el volumen. */
  'UNHEALTHY',
] as const;

export type VolumeState = (typeof VOLUME_STATES)[number];

export const VOLUME_ISSUE_CODES = [
  'NOT_CONFIGURED',
  'MOUNTINFO_UNREADABLE',
  'MOUNTPOINT_INVALID',
  'NOT_MOUNTED',
  'MOUNT_AMBIGUOUS',
  'MOUNT_CHANGED',
  'DEVICE_ABSENT',
  'SOURCE_MISMATCH',
  'MOUNT_NOT_FS_ROOT',
  'FSTYPE_UNEXPECTED',
  'FORCED_MOUNT',
  'NOT_ONBOARDED',
  'MARKER_MISSING',
  'MARKER_INVALID',
  'MARKER_MISMATCH',
  'INTERNAL_DIR_INVALID',
  'DATA_ROOT_INVALID',
  'MOUNT_READ_ONLY',
  'PERMISSION_DENIED',
  'IO_ERROR',
  'IO_STALLED',
  'IO_TIMEOUT',
  'PROBE_FAILED',
] as const;

export type VolumeIssueCode = (typeof VOLUME_ISSUE_CODES)[number];

export interface VolumeIssue {
  readonly code: VolumeIssueCode;
  /** Mensaje para el usuario (es-ES). */
  readonly message: string;
  readonly detail?: Readonly<Record<string, string>>;
}

export interface VolumeMountInfo {
  readonly mountPoint: string;
  readonly source: string;
  readonly fsType: string;
  readonly readOnly: boolean;
  readonly options: readonly string[];
}

export interface VolumeStatus {
  readonly state: VolumeState;
  /** Vacío solo en READY e INITIALIZING. La primera entrada es la causa del estado. */
  readonly issues: readonly VolumeIssue[];
  /** Aumenta cada vez que cambia el estado o la identidad del montaje. */
  readonly generation: number;
  /** ISO 8601. */
  readonly checkedAt: string;
  readonly mount: VolumeMountInfo | null;
}

/**
 * Reparación automática del disco (ADR-0032), según el último estado que dejó el agente root en
 * este arranque. `pending`: aviso recibido, aún sin desmontar; `running`: comprobando/reparando.
 */
export const VOLUME_REPAIR_PHASES = ['pending', 'running', 'done', 'failed'] as const;
export type VolumeRepairPhase = (typeof VOLUME_REPAIR_PHASES)[number];

export const VOLUME_REPAIR_RESULTS = [
  /** Estaba bien: no hubo que cambiar nada. */
  'clean',
  /** Tenía errores y han quedado reparados (y verificados). */
  'repaired',
  /** La reparación no lo ha dejado limpio: se monta en solo lectura. */
  'errors_left',
  /** Error de lectura/escritura o no terminó a tiempo (disco o alimentación). */
  'io_error',
  /** No se pudo desmontar: algo seguía usando el disco. */
  'busy',
  /** Demasiadas reparaciones en 24 h: se deja en solo lectura. */
  'limit',
] as const;
export type VolumeRepairResult = (typeof VOLUME_REPAIR_RESULTS)[number];

export interface VolumeRepairStatus {
  readonly phase: VolumeRepairPhase;
  /** `dirty`: el disco no se desmontó bien (corte de luz); `readonly`: el kernel lo puso en solo lectura. */
  readonly trigger: 'dirty' | 'readonly';
  readonly result: VolumeRepairResult | null;
  /** ISO 8601. */
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** Respuesta de `GET /system/storage`: estado del volumen y, si es legible, su espacio. */
export interface StorageResponse extends VolumeStatus {
  readonly space: { readonly totalBytes: number; readonly freeBytes: number; readonly reservedBytes: number } | null;
  /** Última reparación automática de este arranque; `null` si no ha hecho falta ninguna. */
  readonly repair: VolumeRepairStatus | null;
}

/** ¿Se está comprobando o reparando el disco ahora mismo? */
export function volumeRepairActive(repair: VolumeRepairStatus | null | undefined): boolean {
  return repair?.phase === 'pending' || repair?.phase === 'running';
}

export function volumeAllowsMutations(state: VolumeState): boolean {
  return state === 'READY';
}

export function volumeAllowsReads(state: VolumeState): boolean {
  return state === 'READY' || state === 'READ_ONLY';
}
