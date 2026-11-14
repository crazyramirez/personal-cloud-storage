/**
 * Llaves de acceso (passkeys, WebAuthn nivel 2): entrar con Face ID, Touch ID, Windows Hello o
 * la huella del móvil. La biometría nunca sale del dispositivo: el servidor solo guarda una clave
 * PÚBLICA por dispositivo y comprueba firmas sobre un reto aleatorio de un solo uso.
 *
 * Implementación sin dependencias: CBOR mínimo, claves COSE (ES256, RS256, Ed25519) y
 * verificación con node:crypto. Se exige verificación de usuario (UV: biometría o PIN) y
 * presencia (UP). No se pide atestación («none»): no se necesita saber el fabricante.
 */

import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { AppError } from '../errors.ts';

export const COSE_ES256 = -7;
export const COSE_RS256 = -257;
export const COSE_EDDSA = -8;
export const SUPPORTED_ALGORITHMS = [COSE_ES256, COSE_EDDSA, COSE_RS256] as const;

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

// ── CBOR (RFC 8949): solo lo que usa WebAuthn ───────────────────────────────────────────────

export type CborValue = number | bigint | string | Uint8Array | boolean | null | undefined | CborValue[] | Map<CborValue, CborValue>;

/** Decodifica un valor CBOR desde `offset`. Devuelve el valor y la posición siguiente. */
export function decodeCbor(data: Uint8Array, offset = 0, depth = 0): { value: CborValue; next: number } {
  if (depth > 16) throw new AppError('VALIDATION_FAILED', 'CBOR demasiado anidado');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const need = (n: number): void => {
    if (offset + n > data.length) throw new AppError('VALIDATION_FAILED', 'CBOR truncado');
  };
  need(1);
  const initial = data[offset] as number;
  offset += 1;
  const major = initial >> 5;
  const info = initial & 0x1f;

  const readArgument = (): number => {
    if (info < 24) return info;
    if (info === 24) { need(1); const v = data[offset] as number; offset += 1; return v; }
    if (info === 25) { need(2); const v = view.getUint16(offset); offset += 2; return v; }
    if (info === 26) { need(4); const v = view.getUint32(offset); offset += 4; return v; }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(offset);
      offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new AppError('VALIDATION_FAILED', 'CBOR: entero demasiado grande');
      return Number(v);
    }
    throw new AppError('VALIDATION_FAILED', 'CBOR: longitud indefinida no admitida');
  };

  switch (major) {
    case 0:
      return { value: readArgument(), next: offset };
    case 1:
      return { value: -1 - readArgument(), next: offset };
    case 2: {
      const length = readArgument();
      need(length);
      return { value: data.slice(offset, offset + length), next: offset + length };
    }
    case 3: {
      const length = readArgument();
      need(length);
      return { value: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, offset + length)), next: offset + length };
    }
    case 4: {
      const length = readArgument();
      if (length > 1000) throw new AppError('VALIDATION_FAILED', 'CBOR: lista demasiado larga');
      const items: CborValue[] = [];
      for (let i = 0; i < length; i++) {
        const item = decodeCbor(data, offset, depth + 1);
        items.push(item.value);
        offset = item.next;
      }
      return { value: items, next: offset };
    }
    case 5: {
      const length = readArgument();
      if (length > 1000) throw new AppError('VALIDATION_FAILED', 'CBOR: mapa demasiado largo');
      const map = new Map<CborValue, CborValue>();
      for (let i = 0; i < length; i++) {
        const key = decodeCbor(data, offset, depth + 1);
        const value = decodeCbor(data, key.next, depth + 1);
        map.set(key.value, value.value);
        offset = value.next;
      }
      return { value: map, next: offset };
    }
    case 7:
      if (info === 20) return { value: false, next: offset };
      if (info === 21) return { value: true, next: offset };
      if (info === 22) return { value: null, next: offset };
      if (info === 23) return { value: undefined, next: offset };
      throw new AppError('VALIDATION_FAILED', 'CBOR: valor simple no admitido');
    default:
      throw new AppError('VALIDATION_FAILED', 'CBOR: tipo no admitido');
  }
}

function bytesOf(value: CborValue, what: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new AppError('VALIDATION_FAILED', `WebAuthn: falta ${what}`);
  return value;
}

// ── Datos del autenticador y claves COSE ────────────────────────────────────────────────────

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly flags: number;
  readonly signCount: number;
  readonly credentialId: Uint8Array | null;
  readonly publicKey: Map<CborValue, CborValue> | null;
}

export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) throw new AppError('VALIDATION_FAILED', 'WebAuthn: datos del autenticador demasiado cortos');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32] as number;
  const signCount = view.getUint32(33);
  let credentialId: Uint8Array | null = null;
  let publicKey: Map<CborValue, CborValue> | null = null;
  if ((flags & FLAG_AT) !== 0) {
    if (data.length < 55) throw new AppError('VALIDATION_FAILED', 'WebAuthn: credencial truncada');
    const idLength = view.getUint16(53);
    if (idLength > 1023 || data.length < 55 + idLength) throw new AppError('VALIDATION_FAILED', 'WebAuthn: credencial no válida');
    credentialId = data.slice(55, 55 + idLength);
    const key = decodeCbor(data, 55 + idLength);
    if (!(key.value instanceof Map)) throw new AppError('VALIDATION_FAILED', 'WebAuthn: clave pública no válida');
    publicKey = key.value;
  }
  return { rpIdHash: data.slice(0, 32), flags, signCount, credentialId, publicKey };
}

const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

/** Clave COSE → { algoritmo, clave pública en DER SPKI }. */
export function coseToPublicKey(cose: Map<CborValue, CborValue>): { algorithm: number; spki: Buffer } {
  const kty = cose.get(1);
  const alg = cose.get(3);
  let key: KeyObject;
  if (kty === 2 && alg === COSE_ES256) {
    if (cose.get(-1) !== 1) throw new AppError('VALIDATION_FAILED', 'WebAuthn: curva no admitida');
    key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64url(bytesOf(cose.get(-2), 'x')), y: b64url(bytesOf(cose.get(-3), 'y')) }, format: 'jwk' });
  } else if (kty === 3 && alg === COSE_RS256) {
    key = createPublicKey({ key: { kty: 'RSA', n: b64url(bytesOf(cose.get(-1), 'n')), e: b64url(bytesOf(cose.get(-2), 'e')) }, format: 'jwk' });
  } else if (kty === 1 && alg === COSE_EDDSA) {
    if (cose.get(-1) !== 6) throw new AppError('VALIDATION_FAILED', 'WebAuthn: curva no admitida');
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b64url(bytesOf(cose.get(-2), 'x')) }, format: 'jwk' });
  } else {
    throw new AppError('VALIDATION_FAILED', 'WebAuthn: algoritmo de clave no admitido');
  }
  return { algorithm: alg, spki: key.export({ type: 'spki', format: 'der' }) };
}

export function verifySignature(algorithm: number, spki: Buffer, data: Buffer, signature: Buffer): boolean {
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  try {
    if (algorithm === COSE_ES256) return verify('sha256', data, { key, dsaEncoding: 'der' }, signature);
    if (algorithm === COSE_RS256) return verify('sha256', data, key, signature);
    if (algorithm === COSE_EDDSA) return verify(null, data, key, signature);
  } catch {
    return false;
  }
  return false;
}

// ── Retos ───────────────────────────────────────────────────────────────────────────────────

interface Challenge {
  readonly kind: 'register' | 'login';
  readonly userId: number | null;
  readonly rpId: string;
  readonly origin: string;
  readonly expires: number;
}

/** Retos de un solo uso en memoria (un único proceso). Caducan a los 5 minutos. */
export class ChallengeStore {
  readonly #items = new Map<string, Challenge>();
  readonly #ttlMs: number;

  constructor(ttlMs = 5 * 60 * 1000) {
    this.#ttlMs = ttlMs;
  }

  issue(kind: Challenge['kind'], userId: number | null, rpId: string, origin: string, now: number): string {
    for (const [key, item] of this.#items) if (item.expires <= now) this.#items.delete(key);
    // Si alguien pide retos en masa, se descartan los más antiguos (no se bloquea a nadie).
    while (this.#items.size >= 1000) this.#items.delete(this.#items.keys().next().value as string);
    const challenge = randomBytes(32).toString('base64url');
    this.#items.set(challenge, { kind, userId, rpId, origin, expires: now + this.#ttlMs });
    return challenge;
  }

  /** Consume el reto (un solo uso). Lanza si no existe, caducó o no corresponde. */
  consume(challenge: string, kind: Challenge['kind'], now: number): Challenge {
    const item = this.#items.get(challenge);
    this.#items.delete(challenge);
    if (item === undefined || item.expires <= now || item.kind !== kind) {
      throw new AppError('UNAUTHENTICATED', 'La solicitud ha caducado. Vuelve a intentarlo.');
    }
    return item;
  }
}

// ── Verificación de ceremonias ──────────────────────────────────────────────────────────────

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
  readonly crossOrigin?: boolean;
}

function parseClientData(raw: Buffer, type: string): ClientData {
  let data: ClientData;
  try {
    data = JSON.parse(raw.toString('utf8')) as ClientData;
  } catch {
    throw new AppError('VALIDATION_FAILED', 'WebAuthn: clientDataJSON no válido');
  }
  if (data.type !== type) throw new AppError('VALIDATION_FAILED', 'WebAuthn: tipo de operación incorrecto');
  if (data.crossOrigin === true) throw new AppError('FORBIDDEN', 'WebAuthn: operación desde otro origen');
  return data;
}

function checkRpAndFlags(auth: AuthenticatorData, rpId: string): void {
  const expected = createHash('sha256').update(rpId).digest();
  if (!timingSafeEqual(Buffer.from(auth.rpIdHash), expected)) throw new AppError('FORBIDDEN', 'WebAuthn: la llave pertenece a otro sitio');
  if ((auth.flags & FLAG_UP) === 0) throw new AppError('FORBIDDEN', 'WebAuthn: falta la presencia del usuario');
  if ((auth.flags & FLAG_UV) === 0) throw new AppError('FORBIDDEN', 'WebAuthn: el dispositivo no verificó la identidad (biometría o PIN)');
}

export interface RegistrationInput {
  readonly clientDataJSON: string;
  readonly attestationObject: string;
}

export interface RegisteredCredential {
  readonly id: string;
  readonly algorithm: number;
  readonly publicKey: string;
  readonly signCount: number;
}

export function verifyRegistration(input: RegistrationInput, challenges: ChallengeStore, userId: number, now: number): RegisteredCredential {
  const clientRaw = Buffer.from(input.clientDataJSON, 'base64url');
  const client = parseClientData(clientRaw, 'webauthn.create');
  const challenge = challenges.consume(client.challenge, 'register', now);
  if (challenge.userId !== userId) throw new AppError('FORBIDDEN', 'WebAuthn: el reto pertenece a otra sesión');
  if (client.origin !== challenge.origin) throw new AppError('FORBIDDEN', 'WebAuthn: origen no permitido');

  const attestation = decodeCbor(Buffer.from(input.attestationObject, 'base64url')).value;
  if (!(attestation instanceof Map)) throw new AppError('VALIDATION_FAILED', 'WebAuthn: atestación no válida');
  const auth = parseAuthenticatorData(bytesOf(attestation.get('authData'), 'authData'));
  checkRpAndFlags(auth, challenge.rpId);
  if (auth.credentialId === null || auth.publicKey === null) throw new AppError('VALIDATION_FAILED', 'WebAuthn: falta la credencial');
  const key = coseToPublicKey(auth.publicKey);
  return { id: b64url(auth.credentialId), algorithm: key.algorithm, publicKey: key.spki.toString('base64'), signCount: auth.signCount };
}

export interface AssertionInput {
  readonly clientDataJSON: string;
  readonly authenticatorData: string;
  readonly signature: string;
}

export interface StoredCredential {
  readonly algorithm: number;
  readonly publicKey: string;
  readonly signCount: number;
}

/** Verifica un inicio de sesión. Devuelve el nuevo contador de firmas. */
export function verifyAssertion(input: AssertionInput, challenges: ChallengeStore, stored: StoredCredential, now: number): number {
  const clientRaw = Buffer.from(input.clientDataJSON, 'base64url');
  const client = parseClientData(clientRaw, 'webauthn.get');
  const challenge = challenges.consume(client.challenge, 'login', now);
  if (client.origin !== challenge.origin) throw new AppError('FORBIDDEN', 'WebAuthn: origen no permitido');
  const authRaw = Buffer.from(input.authenticatorData, 'base64url');
  const auth = parseAuthenticatorData(authRaw);
  checkRpAndFlags(auth, challenge.rpId);
  const signed = Buffer.concat([authRaw, createHash('sha256').update(clientRaw).digest()]);
  if (!verifySignature(stored.algorithm, Buffer.from(stored.publicKey, 'base64'), signed, Buffer.from(input.signature, 'base64url'))) {
    throw new AppError('UNAUTHENTICATED', 'La llave de acceso no es válida');
  }
  // Contador: si ambos lo usan y no avanza, la llave puede estar clonada (las passkeys sincronizadas usan 0).
  if (stored.signCount > 0 && auth.signCount <= stored.signCount) {
    throw new AppError('UNAUTHENTICATED', 'Esta llave de acceso parece duplicada: se ha bloqueado por seguridad');
  }
  return Math.max(auth.signCount, stored.signCount); // nunca se reduce el contador guardado
}
