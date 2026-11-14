/**
 * Contraseñas con Argon2id nativo de Node (OpenSSL), sin dependencias (ADR-0002).
 * Formato almacenado: cadena PHC `$argon2id$v=19$m=<KiB>,t=<pasadas>,p=<hilos>$<sal>$<hash>`.
 * Parámetros: 64 MiB, 3 pasadas (recomendación OWASP holgada; ~0,5 s en una Raspberry Pi 4).
 */

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

interface Argon2Params {
  readonly memory: number;
  readonly passes: number;
  readonly parallelism: number;
}

const CURRENT: Argon2Params = { memory: 65536, passes: 3, parallelism: 1 };
const TAG_LENGTH = 32;
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{16,64})\$([A-Za-z0-9+/]{32,128})$/;

export const MIN_PASSWORD_LENGTH = 12;

function b64(buffer: Buffer): string {
  return buffer.toString('base64').replace(/=+$/, '');
}

function derive(password: string, nonce: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      {
        message: Buffer.from(password.normalize('NFC'), 'utf8'),
        nonce,
        memory: params.memory,
        passes: params.passes,
        parallelism: params.parallelism,
        tagLength,
      },
      (error, derived) => {
        if (error) reject(error);
        else resolve(Buffer.from(derived));
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const tag = await derive(password, nonce, CURRENT, TAG_LENGTH);
  return `$argon2id$v=19$m=${CURRENT.memory},t=${CURRENT.passes},p=${CURRENT.parallelism}$${b64(nonce)}$${b64(tag)}`;
}

/** Comparación en tiempo constante. Devuelve false ante cualquier hash malformado. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = PHC.exec(encoded);
  if (match === null) return false;
  const params: Argon2Params = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) };
  // Límites defensivos: un hash manipulado no debe poder pedir memoria o tiempo desmesurados.
  if (params.memory < 8 || params.memory > 1048576 || params.passes < 1 || params.passes > 10 || params.parallelism < 1 || params.parallelism > 8) {
    return false;
  }
  const nonce = Buffer.from(match[4] ?? '', 'base64');
  const expected = Buffer.from(match[5] ?? '', 'base64');
  const actual = await derive(password, nonce, params, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let decoy: Promise<string> | null = null;

/**
 * Gasta el mismo tiempo que una verificación real cuando el usuario no existe, para que el
 * tiempo de respuesta no revele qué nombres de usuario son válidos.
 */
export async function burnVerification(password: string): Promise<void> {
  decoy ??= hashPassword(randomBytes(18).toString('base64'));
  await verifyPassword(password, await decoy);
}
