/**
 * Implementación Linux del StorageProbe. Solo lectura: lstat/stat/realpath/open(O_RDONLY)/access.
 */

import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, readFile, realpath, stat } from 'node:fs/promises';
import { decodeDevT, type DeviceNumber } from './device-number.ts';
import type { BlockStats, PathInfo, StorageProbe } from './probe.ts';

const MOUNTINFO_PATH = '/proc/self/mountinfo';
const SYS_BLOCK = '/sys/dev/block';

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function toPathInfo(stats: BigIntStats): PathInfo {
  const kind = stats.isSymbolicLink()
    ? 'symlink'
    : stats.isDirectory()
      ? 'directory'
      : stats.isFile()
        ? 'file'
        : stats.isBlockDevice()
          ? 'block-device'
          : 'other';
  return { kind, dev: decodeDevT(stats.dev), rdev: decodeDevT(stats.rdev), size: stats.size };
}

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

export class LinuxStorageProbe implements StorageProbe {
  async readMountInfo(): Promise<string> {
    return readFile(MOUNTINFO_PATH, 'utf8');
  }

  async lstat(path: string): Promise<PathInfo | null> {
    try {
      return toPathInfo(await lstat(path, { bigint: true }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async stat(path: string): Promise<PathInfo | null> {
    try {
      return toPathInfo(await stat(path, { bigint: true }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async realpath(path: string): Promise<string | null> {
    try {
      return await realpath(path);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readTextFile(path: string, maxBytes: number): Promise<string> {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw errnoError('EFBIG', `${path} supera ${maxBytes} bytes`);
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async checkWritable(path: string): Promise<void> {
    await access(path, constants.W_OK);
  }

  async readBlockStats(device: DeviceNumber): Promise<BlockStats | null> {
    try {
      const fields = (await readFile(`${SYS_BLOCK}/${device.major}:${device.minor}/stat`, 'utf8')).trim().split(/\s+/).map(Number);
      // Campos: 0 lecturas completadas · 4 escrituras completadas · 8 en curso (Documentation/block/stat.rst).
      const [reads, , , , writes, , , , inFlight] = fields;
      if (reads === undefined || writes === undefined || inFlight === undefined || fields.some((value) => !Number.isFinite(value))) return null;
      return { completed: reads + writes, inFlight };
    } catch {
      return null;
    }
  }
}
