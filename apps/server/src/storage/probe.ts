/**
 * Puerto de observación del sistema usado por el StorageGuardian.
 *
 * Es deliberadamente de SOLO LECTURA: ninguna operación de este interfaz escribe en disco.
 * La implementación real (linux-probe.ts) usa /proc y node:fs; los tests usan una sonda
 * falsa en memoria, de modo que las pruebas nunca tocan volúmenes reales.
 *
 * Contrato de errores: `lstat`, `stat` y `realpath` devuelven null si la ruta no existe
 * (ENOENT/ENOTDIR). Cualquier otro error se propaga como excepción con `code` errno.
 */

import type { DeviceNumber } from './device-number.ts';

export type PathKind = 'file' | 'directory' | 'symlink' | 'block-device' | 'other';

export interface PathInfo {
  readonly kind: PathKind;
  /** Dispositivo que contiene la ruta (st_dev). */
  readonly dev: DeviceNumber;
  /** Dispositivo representado, solo significativo en block-device (st_rdev). */
  readonly rdev: DeviceNumber;
  readonly size: bigint;
}

export interface StorageProbe {
  /** Contenido de /proc/self/mountinfo. */
  readMountInfo(): Promise<string>;
  /** No sigue enlaces simbólicos. */
  lstat(path: string): Promise<PathInfo | null>;
  /** Sigue enlaces simbólicos. */
  stat(path: string): Promise<PathInfo | null>;
  realpath(path: string): Promise<string | null>;
  /** Lee un fichero regular sin seguir symlinks; falla si supera maxBytes o no es UTF-8 válido. */
  readTextFile(path: string, maxBytes: number): Promise<string>;
  /** access(W_OK): no escribe nada, solo pregunta al kernel. */
  checkWritable(path: string): Promise<void>;
  /**
   * Contadores del dispositivo de bloques (/sys/dev/block/M:m/stat). Se leen del kernel, nunca
   * del disco: no se cuelgan aunque el disco deje de responder. null si no están disponibles.
   */
  readBlockStats?(device: DeviceNumber): Promise<BlockStats | null>;
}

export interface BlockStats {
  /** Lecturas + escrituras completadas desde el arranque. */
  readonly completed: number;
  /** Peticiones enviadas al disco y aún sin respuesta. */
  readonly inFlight: number;
}
