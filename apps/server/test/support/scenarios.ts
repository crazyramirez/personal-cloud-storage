/**
 * Mundos simulados realistas: Orange Pi con raíz en microSD (mmcblk0p2) y HDD USB en sda1.
 */

import type { DeviceNumber } from '../../src/storage/device-number.ts';
import { StorageGuardian, type ConfiguredFsType, type StorageGuardianOptions } from '../../src/storage/storage-guardian.ts';
import { FakeProbe } from './fake-probe.ts';

export const MOUNTPOINT = '/srv/pcloud';
export const FS_UUID = '1A2B-3C4D';
export const NTFS_UUID = '0123456789ABCDEF';
export const MARKER = '3f1c2b7e-8d4a-4c1e-9a2b-5d6e7f8a9b0c';
export const OTHER_MARKER = '9e8d7c6b-5a49-4382-a716-0f1e2d3c4b5a';

export const SD_ROOT: DeviceNumber = { major: 179, minor: 2 };
export const HDD: DeviceNumber = { major: 8, minor: 1 };
export const OTHER_DISK: DeviceNumber = { major: 8, minor: 17 };
export const FUSE_ANON: DeviceNumber = { major: 0, minor: 45 };
const DEVTMPFS: DeviceNumber = { major: 0, minor: 5 };

export interface MountLine {
  id: number;
  parent: number;
  dev: DeviceNumber;
  root?: string;
  mountPoint: string;
  options?: string;
  fsType: string;
  source: string;
  superOptions?: string;
}

export function mountLine(line: MountLine): string {
  return [
    line.id,
    line.parent,
    `${line.dev.major}:${line.dev.minor}`,
    line.root ?? '/',
    line.mountPoint,
    line.options ?? 'rw,nosuid,nodev,noexec,noatime',
    'shared:30',
    '-',
    line.fsType,
    line.source,
    line.superOptions ?? 'rw',
  ].join(' ');
}

/** Montajes típicos de Ubuntu en la Orange Pi, sin el HDD. */
export const SYSTEM_MOUNTS = [
  '22 1 179:2 / / rw,noatime shared:1 - ext4 /dev/mmcblk0p2 rw,commit=600,errors=remount-ro',
  '23 22 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw',
  '24 22 0:22 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw',
  '25 22 0:5 / /dev rw,nosuid,relatime shared:2 - devtmpfs udev rw,size=470000k,nr_inodes=117500,mode=755',
  '26 22 0:24 / /run rw,nosuid,nodev,noexec,relatime shared:5 - tmpfs tmpfs rw,size=98000k,mode=755',
  '27 22 179:1 / /boot rw,relatime shared:28 - vfat /dev/mmcblk0p1 rw,fmask=0022,dmask=0022,codepage=437,iocharset=ascii',
];

export function hddMountLine(fsType: ConfiguredFsType, overrides: Partial<MountLine> = {}): MountLine {
  const base: Record<ConfiguredFsType, MountLine> = {
    exfat: {
      id: 40, parent: 22, dev: HDD, mountPoint: MOUNTPOINT, fsType: 'exfat', source: '/dev/sda1',
      superOptions: 'rw,uid=998,gid=998,fmask=0177,dmask=0077,allow_utime=0022,iocharset=utf8,errors=remount-ro',
    },
    ntfs3: {
      id: 40, parent: 22, dev: HDD, mountPoint: MOUNTPOINT, fsType: 'ntfs3', source: '/dev/sda1',
      superOptions: 'rw,uid=998,gid=998,fmask=0177,dmask=0077,iocharset=utf8,windows_names',
    },
    'ntfs-3g': {
      id: 40, parent: 22, dev: FUSE_ANON, mountPoint: MOUNTPOINT, fsType: 'fuseblk', source: '/dev/sda1',
      superOptions: 'rw,user_id=0,group_id=0,allow_other,blksize=4096',
    },
  };
  return { ...base[fsType], ...overrides };
}

export interface World {
  readonly probe: FakeProbe;
  readonly fsType: ConfiguredFsType;
  readonly uuid: string;
  /** Dispositivo que verán los ficheros del volumen (anónimo en FUSE). */
  readonly volumeDev: DeviceNumber;
  setMounts(...lines: Array<MountLine | string>): void;
}

/** Mundo sano: el guardián debe concluir READY. */
export function healthyWorld(fsType: ConfiguredFsType = 'exfat'): World {
  const probe = new FakeProbe();
  const uuid = fsType === 'exfat' ? FS_UUID : NTFS_UUID;
  const volumeDev = fsType === 'ntfs-3g' ? FUSE_ANON : HDD;
  const setMounts = (...lines: Array<MountLine | string>): void => {
    probe.mountinfo = `${[...SYSTEM_MOUNTS, ...lines.map((l) => (typeof l === 'string' ? l : mountLine(l)))].join('\n')}\n`;
  };
  setMounts(hddMountLine(fsType));
  probe
    .set('/srv', { kind: 'directory', dev: SD_ROOT })
    .set(MOUNTPOINT, { kind: 'directory', dev: volumeDev })
    .set(`${MOUNTPOINT}/.pcloud`, { kind: 'directory', dev: volumeDev })
    .set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'file', dev: volumeDev, content: `pcloud-volume-v1 ${MARKER}\n` })
    .set(`${MOUNTPOINT}/data`, { kind: 'directory', dev: volumeDev })
    .set(`/dev/disk/by-uuid/${uuid}`, { kind: 'symlink', dev: DEVTMPFS, target: '/dev/sda1' })
    .set('/dev/sda1', { kind: 'block-device', dev: DEVTMPFS, rdev: HDD })
    .set('/dev/sdb1', { kind: 'block-device', dev: DEVTMPFS, rdev: OTHER_DISK });
  return { probe, fsType, uuid, volumeDev, setMounts };
}

/** Desmontaje limpio: el mountpoint vuelve a ser el directorio vacío de la microSD. */
export function unmountCleanly(world: World): void {
  world.setMounts();
  world.probe
    .set(MOUNTPOINT, { kind: 'directory', dev: SD_ROOT })
    .delete(`${MOUNTPOINT}/.pcloud`, `${MOUNTPOINT}/.pcloud/volume-id`, `${MOUNTPOINT}/data`);
}

/** Desconexión física sin desmontar: el montaje queda obsoleto y desaparecen los nodos /dev. */
export function unplugWithoutUnmount(world: World): void {
  world.probe.delete(`/dev/disk/by-uuid/${world.uuid}`, '/dev/sda1');
}

export function createGuardian(world: World, overrides: Partial<StorageGuardianOptions> = {}): StorageGuardian {
  return new StorageGuardian({
    mountpoint: MOUNTPOINT,
    expectedFsUuid: world.uuid,
    fsType: world.fsType,
    volumeMarker: MARKER,
    dataRootRelative: 'data',
    probe: world.probe,
    clock: () => new Date('2026-11-13T12:00:00.000Z'),
    ...overrides,
  });
}
