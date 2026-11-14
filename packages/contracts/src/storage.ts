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

/** Respuesta de `GET /system/storage`: estado del volumen y, si es legible, su espacio. */
export interface StorageResponse extends VolumeStatus {
  readonly space: { readonly totalBytes: number; readonly freeBytes: number; readonly reservedBytes: number } | null;
}

export function volumeAllowsMutations(state: VolumeState): boolean {
  return state === 'READY';
}

export function volumeAllowsReads(state: VolumeState): boolean {
  return state === 'READY' || state === 'READ_ONLY';
}
