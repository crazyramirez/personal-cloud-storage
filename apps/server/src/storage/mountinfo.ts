/**
 * Parser estricto de /proc/self/mountinfo (proc(5)).
 *
 *   36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue
 *   (1)(2) (3)  (4)   (5)      (6)       (7)   (8) (9)    (10)        (11)
 *
 * Cualquier línea malformada invalida el fichero completo: el StorageGuardian falla en
 * cerrado (UNAVAILABLE) en lugar de razonar sobre una tabla de montajes parcial.
 */

import type { DeviceNumber } from './device-number.ts';

export interface MountInfoEntry extends DeviceNumber {
  readonly mountId: number;
  readonly parentId: number;
  /** Raíz del montaje dentro de su sistema de archivos ("/" salvo bind mounts de subdirectorios). */
  readonly root: string;
  readonly mountPoint: string;
  /** Opciones por montaje (rw/ro, nosuid, nodev, noexec, noatime...). */
  readonly mountOptions: readonly string[];
  readonly optionalFields: readonly string[];
  /** p. ej. "exfat", "ntfs3", "fuseblk" (ntfs-3g), "ext4". */
  readonly fsType: string;
  readonly source: string;
  /** Opciones del superbloque (rw/ro tras errors=remount-ro, uid=, iocharset=, force...). */
  readonly superOptions: readonly string[];
}

export class MountInfoParseError extends Error {
  override readonly name = 'MountInfoParseError';
}

/** Deshace el escape octal del kernel (\040 espacio, \011 tab, \012 salto, \134 barra invertida). */
export function unescapeMountField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

const INTEGER = /^\d+$/;
const MAJOR_MINOR = /^(\d+):(\d+)$/;

function parseLine(line: string, lineNumber: number): MountInfoEntry {
  const fields = line.split(' ');
  const separator = fields.indexOf('-', 6);
  if (fields.length < 10 || separator < 6 || fields.length !== separator + 4) {
    throw new MountInfoParseError(`mountinfo línea ${lineNumber}: estructura inválida`);
  }
  const [id, parent, majorMinor, root, mountPoint, mountOptions] = fields;
  const [fsType, source, superOptions] = fields.slice(separator + 1);
  if (
    id === undefined || parent === undefined || majorMinor === undefined || root === undefined ||
    mountPoint === undefined || mountOptions === undefined || fsType === undefined ||
    source === undefined || superOptions === undefined
  ) {
    throw new MountInfoParseError(`mountinfo línea ${lineNumber}: campos ausentes`);
  }
  const device = MAJOR_MINOR.exec(majorMinor);
  if (!INTEGER.test(id) || !INTEGER.test(parent) || device === null || fsType === '') {
    throw new MountInfoParseError(`mountinfo línea ${lineNumber}: identificadores inválidos`);
  }
  return {
    mountId: Number(id),
    parentId: Number(parent),
    major: Number(device[1]),
    minor: Number(device[2]),
    root: unescapeMountField(root),
    mountPoint: unescapeMountField(mountPoint),
    mountOptions: mountOptions.split(','),
    optionalFields: fields.slice(6, separator),
    fsType,
    source: unescapeMountField(source),
    superOptions: superOptions.split(','),
  };
}

export function parseMountInfo(text: string): MountInfoEntry[] {
  const entries: MountInfoEntry[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line === '' && index === lines.length - 1) continue; // salto final
    entries.push(parseLine(line, index + 1));
  }
  if (entries.length === 0) throw new MountInfoParseError('mountinfo vacío');
  return entries;
}

export type TopMount =
  | { readonly kind: 'none' }
  | { readonly kind: 'found'; readonly entry: MountInfoEntry }
  | { readonly kind: 'ambiguous'; readonly entries: readonly MountInfoEntry[] };

/**
 * Devuelve el montaje visible en `mountPoint`: si hay montajes apilados en la misma ruta
 * (p. ej. bind de systemd ReadWritePaths= y el HDD encima), el visible es el que no es
 * padre de ningún otro montaje en esa ruta.
 */
export function findTopMount(entries: readonly MountInfoEntry[], mountPoint: string): TopMount {
  const stacked = entries.filter((entry) => entry.mountPoint === mountPoint);
  if (stacked.length === 0) return { kind: 'none' };
  const tops = stacked.filter(
    (candidate) => !stacked.some((other) => other !== candidate && other.parentId === candidate.mountId),
  );
  const [top] = tops;
  if (tops.length === 1 && top !== undefined) return { kind: 'found', entry: top };
  return { kind: 'ambiguous', entries: stacked };
}

export function hasMountOption(entry: MountInfoEntry, option: string): boolean {
  return entry.mountOptions.includes(option) || entry.superOptions.includes(option);
}
