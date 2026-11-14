/**
 * Descarga de carpetas y selecciones como ZIP, en streaming y sin ficheros temporales.
 *
 * - Método «store» (sin compresión): la Pi no gasta CPU y la mayoría de fotos, vídeos y documentos
 *   ya están comprimidos.
 * - ZIP64 en todas las entradas: admite archivos y totales de más de 4 GiB.
 * - Nombres en UTF-8 (bit 11) y descriptor de datos (bit 3): el CRC-32 se calcula al leer, sin
 *   leer cada archivo dos veces.
 * - El tamaño total se conoce de antemano (store es determinista), así que se envía
 *   Content-Length y el navegador muestra el progreso real.
 * - Nunca se siguen enlaces simbólicos; los elementos especiales se omiten.
 */

import { open } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { AppError } from '../errors.ts';
import { walkTree } from './operations.ts';
import { parseClientPath, resolveInside } from './paths.ts';

export const MAX_ZIP_ENTRIES = 100_000;
const READ_BUFFER = 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_END = 0x06054b50;
const VERSION = 45; // 4.5: ZIP64
const FLAGS = 0x0008 | 0x0800; // descriptor de datos + nombres UTF-8
const LOCAL_FIXED = 30;
const LOCAL_EXTRA = 20; // ZIP64: cabecera (4) + tamaños a cero (16)
const DESCRIPTOR = 24; // firma + CRC + tamaños de 8 bytes
const CENTRAL_FIXED = 46;
const CENTRAL_EXTRA = 28; // ZIP64: cabecera (4) + tamaño, tamaño comprimido, offset (24)
const END_RECORDS = 56 + 20 + 22;

export interface ZipEntry {
  /** null para carpetas. */
  readonly abs: string | null;
  /** Nombre dentro del ZIP («Fotos/2026/a.jpg», las carpetas terminan en «/»). */
  readonly name: string;
  readonly size: number;
  readonly mtime: Date;
}

export interface ZipPlan {
  readonly entries: readonly ZipEntry[];
  readonly length: number;
  /** Nombre sugerido para el archivo descargado. */
  readonly fileName: string;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Inventario del ZIP: `dir` y opcionalmente `names` (elementos de esa carpeta). Sin `names` se
 * empaqueta el contenido completo de la carpeta.
 */
/** Marca de tiempo local para el nombre del ZIP: 20261114-130326. */
export function zipStamp(now: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
}

/**
 * Nombre del ZIP, siempre con la fecha y hora de la descarga (no se pisan descargas sucesivas):
 * un elemento → «nombre-20261114-130326.zip»; una carpeta completa → «Carpeta-…zip»; varios
 * elementos o la raíz → «files-…zip».
 */
export function zipFileName(dirSegments: readonly string[], selected: readonly string[] | null, now: Date): string {
  const single = selected !== null && new Set(selected).size === 1 ? (selected[0] as string) : null;
  const base = single ?? (selected === null ? dirSegments.at(-1) : undefined) ?? 'files';
  const stem = single !== null ? path.parse(base).name || base : base;
  return `${stem}-${zipStamp(now)}.zip`;
}

export async function planZip(dataRoot: string, dir: string, names: readonly string[] | null, now: Date = new Date()): Promise<ZipPlan> {
  const dirSegments = parseClientPath(dir);
  const base = await resolveInside(dataRoot, dirSegments, 'dir');
  const selected = names ?? null;
  if (selected !== null && selected.length === 0) throw new AppError('VALIDATION_FAILED', 'No hay nada que descargar');

  const roots: Array<{ abs: string; prefix: string }> = [];
  if (selected === null) {
    roots.push({ abs: base.abs, prefix: '' });
  } else {
    const seen = new Set<string>();
    for (const name of selected) {
      if (seen.has(name)) continue;
      seen.add(name);
      const segments = parseClientPath(name);
      if (segments.length !== 1) throw new AppError('INVALID_PATH', 'Los elementos deben estar en la carpeta indicada');
      const resolved = await resolveInside(dataRoot, [...dirSegments, ...segments], 'any');
      roots.push({ abs: resolved.abs, prefix: name });
    }
  }

  const entries: ZipEntry[] = [];
  for (const root of roots) {
    for await (const item of walkTree(root.abs)) {
      if (entries.length >= MAX_ZIP_ENTRIES) {
        throw new AppError('PAYLOAD_TOO_LARGE', `Demasiados elementos para un ZIP (máximo ${MAX_ZIP_ENTRIES})`);
      }
      const rel = root.prefix === '' ? item.rel : item.rel === '' ? root.prefix : `${root.prefix}/${item.rel}`;
      if (rel === '') continue; // la carpeta base no se incluye como entrada
      if (Buffer.byteLength(rel, 'utf8') > 60_000) throw new AppError('PAYLOAD_TOO_LARGE', 'Hay rutas demasiado largas para un ZIP');
      if (item.stats.isDirectory()) entries.push({ abs: null, name: `${rel}/`, size: 0, mtime: item.stats.mtime });
      else if (item.stats.isFile()) entries.push({ abs: item.abs, name: rel, size: item.stats.size, mtime: item.stats.mtime });
    }
  }

  let length = END_RECORDS;
  for (const entry of entries) {
    const nameBytes = Buffer.byteLength(entry.name, 'utf8');
    length += LOCAL_FIXED + nameBytes + LOCAL_EXTRA + entry.size + DESCRIPTOR + CENTRAL_FIXED + nameBytes + CENTRAL_EXTRA;
  }

  return { entries, length, fileName: zipFileName(dirSegments, selected, now) };
}

interface Written {
  readonly name: Buffer;
  readonly crc: number;
  readonly size: number;
  readonly offset: number;
  readonly time: number;
  readonly date: number;
  readonly isDir: boolean;
}

/** Genera el ZIP. Lanza si un archivo cambia de tamaño durante la lectura (la descarga se corta). */
export async function* streamZip(plan: ZipPlan): AsyncGenerator<Buffer> {
  const written: Written[] = [];
  let offset = 0;

  for (const entry of plan.entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const { time, date } = dosDateTime(entry.mtime);
    const local = Buffer.alloc(LOCAL_FIXED + name.length + LOCAL_EXTRA);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(0, 14); // CRC en el descriptor
    local.writeUInt32LE(0xffffffff, 18);
    local.writeUInt32LE(0xffffffff, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(LOCAL_EXTRA, 28);
    name.copy(local, LOCAL_FIXED);
    local.writeUInt16LE(0x0001, LOCAL_FIXED + name.length);
    local.writeUInt16LE(16, LOCAL_FIXED + name.length + 2); // tamaños a cero: van en el descriptor
    yield local;

    let crc = 0;
    let size = 0;
    if (entry.abs !== null && entry.size > 0) {
      const handle = await open(entry.abs, 'r');
      try {
        while (size < entry.size) {
          const buffer = Buffer.allocUnsafe(Math.min(READ_BUFFER, entry.size - size));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
          if (bytesRead === 0) break;
          const chunk = bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
          crc = crc32(chunk, crc);
          size += bytesRead;
          yield chunk;
        }
      } finally {
        await handle.close();
      }
      if (size !== entry.size) throw new Error(`El archivo cambió durante la descarga: ${entry.name}`);
    }

    const descriptor = Buffer.alloc(DESCRIPTOR);
    descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
    descriptor.writeUInt32LE(crc >>> 0, 4);
    descriptor.writeBigUInt64LE(BigInt(size), 8);
    descriptor.writeBigUInt64LE(BigInt(size), 16);
    yield descriptor;

    written.push({ name, crc: crc >>> 0, size, offset, time, date, isDir: entry.abs === null });
    offset += local.length + size + DESCRIPTOR;
  }

  const centralStart = offset;
  for (const item of written) {
    const central = Buffer.alloc(CENTRAL_FIXED + item.name.length + CENTRAL_EXTRA);
    central.writeUInt32LE(SIG_CENTRAL, 0);
    central.writeUInt16LE((3 << 8) | VERSION, 4); // creado en Unix
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(FLAGS, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(item.time, 12);
    central.writeUInt16LE(item.date, 14);
    central.writeUInt32LE(item.crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(item.name.length, 28);
    central.writeUInt16LE(CENTRAL_EXTRA, 30);
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    // Atributos externos: permisos Unix en los 16 bits altos + bit de carpeta de MS-DOS.
    central.writeUInt32LE((((item.isDir ? 0o40755 : 0o100644) << 16) | (item.isDir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(0xffffffff, 42);
    item.name.copy(central, CENTRAL_FIXED);
    const extra = CENTRAL_FIXED + item.name.length;
    central.writeUInt16LE(0x0001, extra);
    central.writeUInt16LE(24, extra + 2);
    central.writeBigUInt64LE(BigInt(item.size), extra + 4);
    central.writeBigUInt64LE(BigInt(item.size), extra + 12);
    central.writeBigUInt64LE(BigInt(item.offset), extra + 20);
    offset += central.length;
    yield central;
  }
  const centralSize = offset - centralStart;

  const end = Buffer.alloc(END_RECORDS);
  end.writeUInt32LE(SIG_ZIP64_END, 0);
  end.writeBigUInt64LE(44n, 4); // tamaño del registro sin los 12 primeros bytes
  end.writeUInt16LE((3 << 8) | VERSION, 12);
  end.writeUInt16LE(VERSION, 14);
  end.writeUInt32LE(0, 16);
  end.writeUInt32LE(0, 20);
  end.writeBigUInt64LE(BigInt(written.length), 24);
  end.writeBigUInt64LE(BigInt(written.length), 32);
  end.writeBigUInt64LE(BigInt(centralSize), 40);
  end.writeBigUInt64LE(BigInt(centralStart), 48);
  end.writeUInt32LE(SIG_ZIP64_LOCATOR, 56);
  end.writeUInt32LE(0, 60);
  end.writeBigUInt64LE(BigInt(offset), 64); // posición del registro ZIP64
  end.writeUInt32LE(1, 72);
  end.writeUInt32LE(SIG_END, 76);
  end.writeUInt16LE(0, 80); // disco
  end.writeUInt16LE(0, 82); // disco del directorio central
  end.writeUInt16LE(0xffff, 84); // entradas: ver ZIP64
  end.writeUInt16LE(0xffff, 86);
  end.writeUInt32LE(0xffffffff, 88); // tamaño del directorio central: ver ZIP64
  end.writeUInt32LE(0xffffffff, 92); // posición del directorio central: ver ZIP64
  end.writeUInt16LE(0, 96); // comentario
  yield end;
}
