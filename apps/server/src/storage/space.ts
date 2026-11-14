/**
 * Espacio del volumen y reserva de seguridad (spec §7.3): se reserva el MAYOR entre
 * `min_free_percent` del total y `min_free_bytes`; por debajo se bloquean las subidas (507).
 */

import { statfs } from 'node:fs/promises';
import type { VolumeSpace } from '@pcloud/contracts';
import { AppError } from '../errors.ts';

export interface SpacePolicy {
  readonly minFreePercent: number;
  readonly minFreeBytes: number;
}

export async function volumeSpace(mountPoint: string, policy: SpacePolicy): Promise<VolumeSpace> {
  const fs = await statfs(mountPoint);
  const totalBytes = fs.blocks * fs.bsize;
  return {
    totalBytes,
    freeBytes: fs.bavail * fs.bsize,
    reservedBytes: Math.round(Math.max((totalBytes * policy.minFreePercent) / 100, policy.minFreeBytes)),
  };
}

/** Lanza INSUFFICIENT_STORAGE si escribir `bytes` dejaría el volumen por debajo de la reserva. */
export async function assertSpaceFor(mountPoint: string, policy: SpacePolicy, bytes: number): Promise<void> {
  const space = await volumeSpace(mountPoint, policy);
  if (space.freeBytes - space.reservedBytes < bytes) {
    throw new AppError('INSUFFICIENT_STORAGE', 'No queda espacio suficiente en el disco', {
      details: { freeBytes: space.freeBytes, reservedBytes: space.reservedBytes, neededBytes: bytes },
    });
  }
}
