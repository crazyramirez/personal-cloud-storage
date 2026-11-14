/**
 * Números de dispositivo Linux (major:minor).
 *
 * `fs.stat(..., { bigint: true })` devuelve `dev`/`rdev` codificados con `makedev()` de glibc
 * (libuv construye st_dev a partir de statx con esa macro). `/proc/self/mountinfo` los muestra
 * como "major:minor" en decimal. Este módulo convierte entre ambas representaciones.
 */

export interface DeviceNumber {
  readonly major: number;
  readonly minor: number;
}

/** Equivalente a gnu_dev_major / gnu_dev_minor de glibc. */
export function decodeDevT(dev: bigint): DeviceNumber {
  const major = ((dev & 0x00000000000fff00n) >> 8n) | ((dev & 0xfffff00000000000n) >> 32n);
  const minor = (dev & 0x00000000000000ffn) | ((dev & 0x00000ffffff00000n) >> 12n);
  return { major: Number(major), minor: Number(minor) };
}

/** Equivalente a gnu_dev_makedev de glibc. */
export function encodeDevT(device: DeviceNumber): bigint {
  const major = BigInt(device.major);
  const minor = BigInt(device.minor);
  return (
    ((major & 0x00000fffn) << 8n) |
    ((major & 0xfffff000n) << 32n) |
    (minor & 0x000000ffn) |
    ((minor & 0xffffff00n) << 12n)
  );
}

export function sameDevice(a: DeviceNumber, b: DeviceNumber): boolean {
  return a.major === b.major && a.minor === b.minor;
}

export function formatDevice(device: DeviceNumber): string {
  return `${device.major}:${device.minor}`;
}
