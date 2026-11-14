/**
 * Primitivas de durabilidad para ficheros pequeños de control (marcador, configuración).
 * En exFAT/NTFS no se presupone durabilidad absoluta de fsync (spec §7.2); se hace lo posible.
 */

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const FSYNC_UNSUPPORTED = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP']);

/**
 * fsync del directorio para persistir un rename. Solo se tolera que el sistema no lo admita
 * (Windows; EINVAL/ENOTSUP en algunos FS). Cualquier otro error —EIO, ENOSPC…— se propaga: una
 * operación cuyo rename no se pudo hacer duradero no puede darse por confirmada.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return; // Windows no permite abrir directorios para fsync
  const handle = await open(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } catch (error) {
    if (!FSYNC_UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Sustituye `target` de forma atómica: temporal exclusivo en el mismo directorio → fsync → rename →
 * fsync del directorio. Conserva modo, y propietario y grupo si se ejecuta como root.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const previous = await stat(target).catch(() => null);
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${randomUUID()}`);
  const mode = previous === null ? 0o600 : previous.mode & 0o7777;
  const handle = await open(tmp, 'wx', mode);
  try {
    await handle.writeFile(content);
    if (previous !== null) {
      if (typeof process.getuid === 'function' && process.getuid() === 0) await handle.chown(previous.uid, previous.gid);
      await handle.chmod(mode);
    }
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(tmp, target);
  await syncDirectory(dir);
}
