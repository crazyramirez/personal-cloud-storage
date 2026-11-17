/**
 * Emparejar un ordenador con la carpeta de red (ADR-0022).
 *
 * El propietario pulsa «Conectar un ordenador» en Ajustes y ve un código de 6 cifras. En el
 * ordenador, DEV Backup Studio encuentra la nube en la red y envía ese código; a cambio recibe la
 * dirección y las credenciales de la carpeta de red (ADR-0021) y la conecta sola.
 *
 * - Un solo código activo a la vez: pedir otro invalida el anterior.
 * - Caduca a los 10 minutos y sirve una sola vez.
 * - 5 intentos fallidos (de cualquier origen) invalidan el código activo: adivinar 1 de 10⁶
 *   con 5 intentos es una probabilidad de 5 entre un millón.
 * - Las credenciales las escribe pcloud-install-smb.sh en /etc/pcloud/smb.json (root:pcloud 0640);
 *   este servicio solo las lee. Sin ese fichero, el emparejamiento no está disponible.
 */

import { randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface SmbShare {
  /** Nombre del recurso compartido («Copias»). */
  readonly share: string;
  readonly user: string;
  readonly password: string;
}

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: Date;
}

export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_FAILURES = 5;

export class PairingService {
  readonly #file: string;
  readonly #ttlMs: number;
  #active: { code: string; expiresAt: number } | null = null;
  #failures = 0;

  constructor(file = '/etc/pcloud/smb.json', ttlMs = PAIRING_TTL_MS) {
    this.#file = file;
    this.#ttlMs = ttlMs;
  }

  /** Datos de la carpeta de red, o null si no está instalada (o el fichero no es válido). */
  async share(): Promise<SmbShare | null> {
    const raw = await readFile(this.#file, 'utf8').catch(() => null);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Record<keyof SmbShare, unknown>>;
      const { share, user, password } = parsed;
      if (typeof share !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(share)) return null;
      if (typeof user !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(user)) return null;
      if (typeof password !== 'string' || password.length < 12) return null;
      return { share, user, password };
    } catch {
      return null;
    }
  }

  /** Código nuevo (sustituye al anterior). */
  createCode(now: Date): PairingCode {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.#active = { code, expiresAt: now.getTime() + this.#ttlMs };
    this.#failures = 0;
    return { code, expiresAt: new Date(this.#active.expiresAt) };
  }

  /** Código activo, si lo hay (para volver a mostrarlo al recargar Ajustes). */
  current(now: Date): PairingCode | null {
    const active = this.#active;
    if (active === null || active.expiresAt <= now.getTime()) return null;
    return { code: active.code, expiresAt: new Date(active.expiresAt) };
  }

  cancel(): void {
    this.#active = null;
  }

  /** ¿Es el código activo? Si lo es, se gasta. */
  claim(code: string, now: Date): boolean {
    const active = this.#active;
    if (active === null || active.expiresAt <= now.getTime()) {
      this.#active = null;
      return false;
    }
    const a = Buffer.from(code.padEnd(6, ' ').slice(0, 6));
    const b = Buffer.from(active.code);
    if (code.length === 6 && timingSafeEqual(a, b)) {
      this.#active = null;
      return true;
    }
    this.#failures += 1;
    if (this.#failures >= PAIRING_MAX_FAILURES) this.#active = null;
    return false;
  }
}

/** Nombre de carpeta seguro para un equipo («Portátil de Ana» → «Portátil de Ana»; sin / \ : …). */
export function deviceFolder(device: string): string {
  const cleaned = device
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 48);
  return cleaned === '' ? 'Ordenador' : cleaned;
}
