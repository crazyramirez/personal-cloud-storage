/**
 * Política de nombres portables (spec §3.1): lo que se crea a través de la API debe ser válido
 * en Windows, macOS y Linux. Los nombres ya existentes que no la cumplen no se corrigen nunca en
 * silencio: se listan marcados (`portable: false`) y se tratan como solo lectura.
 */

import { AppError } from '../errors.ts';

const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/;
/** Dispositivos reservados de Windows, con o sin extensión (CON, NUL.txt, COM1…). */
const RESERVED_WINDOWS = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(\..*)?$/i;
export const MAX_NAME_UTF16 = 255;

/** Motivo por el que un nombre no es portable, o null si lo es. */
export function portabilityIssue(name: string): string | null {
  if (name.length === 0) return 'Nombre vacío';
  if (name === '.' || name === '..') return 'Nombre reservado';
  if (FORBIDDEN_CHARS.test(name)) return 'Contiene caracteres no válidos en Windows (\\ / : * ? " < > |)';
  if (/[ .]$/.test(name)) return 'Termina en espacio o punto: no válido en Windows';
  if (RESERVED_WINDOWS.test(name)) return 'Nombre reservado en Windows';
  if (name.length > MAX_NAME_UTF16) return 'Nombre demasiado largo (más de 255 caracteres)';
  return null;
}

/** Valida y normaliza (NFC) un nombre nuevo. Lanza INVALID_NAME con el motivo. */
export function checkNewName(raw: string): string {
  const name = raw.normalize('NFC');
  if (/^\s/.test(name)) throw new AppError('INVALID_NAME', 'El nombre no puede empezar por un espacio');
  const issue = portabilityIssue(name);
  if (issue !== null) throw new AppError('INVALID_NAME', issue);
  return name;
}

/**
 * Clave de comparación lógica entre plataformas: NFC + mayúsculas. Dos nombres con la misma
 * clave colisionan en Windows/macOS aunque Linux los distinga.
 */
export function foldKey(name: string): string {
  return name.normalize('NFC').toUpperCase();
}

/** Primer nombre libre: «informe.pdf», «informe (2).pdf», «informe (3).pdf»… */
export function uniqueName(name: string, takenKeys: ReadonlySet<string>): string {
  if (!takenKeys.has(foldKey(name))) return name;
  const dot = name.lastIndexOf('.');
  const hasExtension = dot > 0 && dot < name.length - 1;
  const base = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : '';
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} (${n})${extension}`;
    if (!takenKeys.has(foldKey(candidate))) return candidate;
  }
  throw new AppError('CONFLICT', 'No se pudo encontrar un nombre libre');
}
