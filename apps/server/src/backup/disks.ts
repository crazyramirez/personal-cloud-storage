/**
 * Discos externos conectados (ADR-0017). Solo lectura: `lsblk` lee /sys y la base de udev, no el
 * disco. Se excluyen el disco del sistema, el disco de datos de la nube y lo que no tiene sistema
 * de archivos (o es swap).
 */

import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExternalDisk {
  readonly uuid: string;
  readonly device: string;
  readonly fsType: string;
  readonly compatible: boolean;
  readonly sizeBytes: number;
  readonly label: string | null;
  readonly model: string | null;
  readonly mountpoint: string | null;
}

interface LsblkRow {
  name?: string;
  pkname?: string | null;
  type?: string;
  fstype?: string | null;
  uuid?: string | null;
  size?: number | string | null;
  label?: string | null;
  model?: string | null;
  mountpoint?: string | null;
  mountpoints?: Array<string | null>;
}

const COMPATIBLE = new Set(['exfat', 'ntfs']);
const IGNORED_FS = new Set(['swap', 'crypto_LUKS', 'LVM2_member', 'linux_raid_member', 'zfs_member']);

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const mountpointOf = (row: LsblkRow): string | null => text(row.mountpoint) ?? row.mountpoints?.map(text).find((mp) => mp !== null) ?? null;

/**
 * Interpreta `lsblk -J -b -p -l -o NAME,PKNAME,TYPE,FSTYPE,UUID,SIZE,LABEL,MODEL,MOUNTPOINT`.
 * `dataUuid` es el disco de la nube; `backupMountpoint`, donde se monta el de copia (lo montado
 * ahí sí se lista: es el propio disco de copia).
 */
export function parseLsblk(json: string, dataUuid: string | null, backupMountpoint: string): ExternalDisk[] {
  const parsed = JSON.parse(json) as { blockdevices?: LsblkRow[] };
  const rows = parsed.blockdevices ?? [];
  const byName = new Map(rows.map((row) => [row.name ?? '', row]));
  const diskOf = (row: LsblkRow): string => {
    let current = row;
    for (let i = 0; i < 8; i += 1) {
      const parent = text(current.pkname);
      const next = parent === null ? undefined : byName.get(parent);
      if (next === undefined) break;
      current = next;
    }
    return current.name ?? '';
  };

  // Disco del sistema: el que contiene «/» (y todo lo que cuelga de él).
  const rootRow = rows.find((row) => mountpointOf(row) === '/');
  const systemDisk = rootRow === undefined ? null : diskOf(rootRow);

  const out: ExternalDisk[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const fsType = text(row.fstype);
    const uuid = text(row.uuid);
    const device = text(row.name);
    if (fsType === null || uuid === null || device === null || IGNORED_FS.has(fsType)) continue;
    if (row.type === 'rom' || device.startsWith('/dev/zram') || device.startsWith('/dev/mmcblk')) continue;
    if (systemDisk !== null && diskOf(row) === systemDisk) continue;
    if (dataUuid !== null && uuid.toLowerCase() === dataUuid.toLowerCase()) continue;
    const mountpoint = mountpointOf(row);
    // Montado en otro sitio (por ejemplo, a mano): no es un candidato.
    if (mountpoint !== null && mountpoint !== backupMountpoint) continue;
    if (seen.has(uuid)) continue;
    seen.add(uuid);
    const disk = byName.get(diskOf(row));
    const size = Number(row.size ?? 0);
    out.push({
      uuid,
      device,
      fsType,
      compatible: COMPATIBLE.has(fsType),
      sizeBytes: Number.isFinite(size) ? size : 0,
      label: text(row.label),
      model: text(disk?.model ?? row.model),
      mountpoint,
    });
  }
  return out;
}

export interface DiskLister {
  /** Huella barata del conjunto de discos (cambia al conectar o desconectar uno). */
  fingerprint(): Promise<string>;
  list(): Promise<ExternalDisk[]>;
}

export class LinuxDiskLister implements DiskLister {
  private readonly dataUuid: () => string | null;
  private readonly backupMountpoint: string;

  constructor(dataUuid: () => string | null, backupMountpoint: string) {
    this.dataUuid = dataUuid;
    this.backupMountpoint = backupMountpoint;
  }

  async fingerprint(): Promise<string> {
    const names = await readdir('/dev/disk/by-uuid').catch(() => [] as string[]);
    return names.sort().join(',');
  }

  async list(): Promise<ExternalDisk[]> {
    const { stdout } = await execFileAsync('lsblk', ['-J', '-b', '-p', '-l', '-o', 'NAME,PKNAME,TYPE,FSTYPE,UUID,SIZE,LABEL,MODEL,MOUNTPOINT'], {
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    });
    return parseLsblk(stdout, this.dataUuid(), this.backupMountpoint);
  }
}
