/**
 * Rutas del cliente → rutas reales dentro de la raíz administrada (spec §7.1).
 *
 * El cliente nunca envía rutas del servidor: envía `/a/b/c` relativo a la raíz de datos.
 * La resolución es por componentes: cada tramo se valida y se comprueba con lstat, sin seguir
 * enlaces simbólicos ni puntos de reanálisis, y debe estar en el mismo dispositivo que la raíz.
 * No basta con `startsWith(root)`.
 */

import type { Stats } from 'node:fs';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { AppError, errnoOf } from '../errors.ts';

const MAX_DEPTH = 64;

/**
 * Nombres reservados en el PRIMER nivel de la raíz de datos (STORAGE_CONTRACT §5): la carpeta
 * interna `.pcloud` (con `root_relative: "."` coincide con la raíz) y las carpetas de sistema de
 * Windows y macOS. No se listan, no se pueden abrir ni crear: así ningún usuario puede mover
 * nada dentro de la papelera o del staging internos (que se purgan solos).
 */
const RESERVED_TOP = new Set(['.PCLOUD', 'SYSTEM VOLUME INFORMATION', '$RECYCLE.BIN', '.TRASHES', '.SPOTLIGHT-V100', '.FSEVENTSD', '.TEMPORARYITEMS']);

export function isReservedTopName(name: string): boolean {
  return RESERVED_TOP.has(name.normalize('NFC').toUpperCase());
}

/** `/Proyectos/Web` → ['Proyectos', 'Web']; `/` o `` → []. Lanza INVALID_PATH. */
export function parseClientPath(input: string): string[] {
  if (typeof input !== 'string' || input.length > 4096) throw new AppError('INVALID_PATH', 'Ruta no válida');
  const trimmed = input.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed === '') return [];
  const segments = trimmed.split('/');
  if (segments.length > MAX_DEPTH) throw new AppError('INVALID_PATH', 'Ruta demasiado profunda');
  for (const segment of segments) {
    if (
      segment === '' || segment === '.' || segment === '..' ||
      segment.includes('\u0000') || segment.includes('\\') || segment.length > 255
    ) {
      throw new AppError('INVALID_PATH', 'Ruta no válida');
    }
  }
  if (segments[0] !== undefined && isReservedTopName(segments[0])) throw new AppError('INVALID_PATH', 'Ruta reservada del sistema');
  return segments;
}

export function formatClientPath(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}

export interface ResolvedPath {
  /** Ruta real en el sistema de archivos del servidor. */
  readonly abs: string;
  readonly stats: Stats;
}

async function lstatOrThrow(target: string): Promise<Stats> {
  try {
    return await lstat(target);
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('NOT_FOUND', 'No existe');
    throw error; // EIO, EACCES…: los traduce la capa superior (normalmente vía StorageGuardian)
  }
}

/**
 * Resuelve `segments` dentro de `dataRoot` comprobando cada componente.
 * `expect`: tipo exigido al último componente.
 */
export async function resolveInside(
  dataRoot: string,
  segments: readonly string[],
  expect: 'dir' | 'file' | 'any',
): Promise<ResolvedPath> {
  const rootStats = await lstatOrThrow(dataRoot);
  if (!rootStats.isDirectory()) throw new AppError('NOT_FOUND', 'La raíz de datos no está disponible');
  let current = dataRoot;
  let stats = rootStats;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    stats = await lstatOrThrow(current);
    if (stats.isSymbolicLink()) throw new AppError('INVALID_PATH', 'Los enlaces simbólicos no están admitidos');
    if (stats.dev !== rootStats.dev) throw new AppError('INVALID_PATH', 'La ruta sale del volumen de datos');
    const last = index === segments.length - 1;
    if (!last && !stats.isDirectory()) throw new AppError('NOT_FOUND', 'No existe');
  }
  if (expect === 'dir' && !stats.isDirectory()) throw new AppError('NOT_FOUND', 'No es una carpeta');
  if (expect === 'file' && !stats.isFile()) throw new AppError('NOT_FOUND', 'No es un archivo');
  if (expect === 'any' && !stats.isFile() && !stats.isDirectory()) throw new AppError('NOT_FOUND', 'No es un archivo ni una carpeta');
  return { abs: current, stats };
}
