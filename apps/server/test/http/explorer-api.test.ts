import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ApiErrorBody, BatchResponse, PasskeyLoginOptions, PasskeyRegisterOptions, TrashListResponse } from '@pcloud/contracts';
import { hashPassword } from '../../src/auth/passwords.ts';
import { createUser } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };
const PASSWORD = 'una frase larga y segura';

function code(response: LightMyRequestResponse): string {
  return (response.json() as ApiErrorBody).error.code;
}

// ── CBOR mínimo para fabricar respuestas de un autenticador ─────────────────────────────────

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  const parts = [cborHead(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

/** Autenticador de software: clave EC P-256 (ES256) o Ed25519. */
class SoftAuthenticator {
  readonly credentialId = Buffer.from('credencial-de-prueba-0123456789');
  readonly #kind: 'es256' | 'ed25519';
  readonly #keys;
  signCount = 0;

  constructor(kind: 'es256' | 'ed25519') {
    this.#kind = kind;
    this.#keys = kind === 'es256' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  }

  #cose(): Map<Cbor, Cbor> {
    const jwk = this.#keys.publicKey.export({ format: 'jwk' });
    if (this.#kind === 'es256') {
      return new Map<Cbor, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x as string, 'base64url')], [-3, Buffer.from(jwk.y as string, 'base64url')]]);
    }
    return new Map<Cbor, Cbor>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x as string, 'base64url')]]);
  }

  #authData(rpId: string, flags: number, attested: boolean): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    const parts: Buffer[] = [createHash('sha256').update(rpId).digest(), Buffer.from([flags]), count];
    if (attested) {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), len, this.credentialId, cbor(this.#cose()));
    }
    return Buffer.concat(parts);
  }

  register(challenge: string, origin: string, rpId: string, flags = 0x45): { id: string; clientDataJSON: string; attestationObject: string } {
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin }));
    const attestation = cbor(new Map<Cbor, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.#authData(rpId, flags, true)]]));
    return { id: this.credentialId.toString('base64url'), clientDataJSON: clientData.toString('base64url'), attestationObject: attestation.toString('base64url') };
  }

  login(challenge: string, origin: string, rpId: string, flags = 0x05): { id: string; clientDataJSON: string; authenticatorData: string; signature: string } {
    this.signCount += 1;
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
    const authData = this.#authData(rpId, flags, false);
    const signed = Buffer.concat([authData, createHash('sha256').update(clientData).digest()]);
    const signature =
      this.#kind === 'es256'
        ? createSign('sha256').update(signed).sign(this.#keys.privateKey)
        : edSign(null, signed, this.#keys.privateKey);
    return {
      id: this.credentialId.toString('base64url'),
      clientDataJSON: clientData.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    };
  }
}

describe('API del explorador, papelera, cuenta y passkeys', () => {
  let h: Harness;
  let app: FastifyInstance;
  let cookie = '';
  /** La contraseña de «ana» cambia en un test anterior. */
  let currentPassword = PASSWORD;

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...(method === 'GET' ? {} : CSRF), ...(cookie === '' ? {} : { cookie }), host: 'localhost', ...headers },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });

  before(async () => {
    h = await createHarness();
    createUser(h.db, 'ana', await hashPassword(PASSWORD), 'owner', new Date());
    createUser(h.db, 'luis', await hashPassword(PASSWORD), 'user', new Date());
    app = await buildApp({ config: { ...h.config, trash: { enabled: true, retentionDays: 30 } }, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false });
    const login = await call('POST', '/auth/login', { username: 'ana', password: PASSWORD });
    assert.equal(login.statusCode, 200);
    cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    await mkdir(path.join(h.dataRoot, 'Fotos'));
    await writeFile(path.join(h.dataRoot, 'Fotos', 'a.jpg'), 'jpg');
    await writeFile(path.join(h.dataRoot, 'nota.txt'), '<script>alert(1)</script>');
  });

  after(async () => {
    await app.close();
    await h.dispose();
  });

  it('cabeceras de seguridad propias en toda respuesta de la API', async () => {
    const response = await call('GET', '/auth/me');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
  });

  it('crear, renombrar, copiar, mover, papelera y restaurar por HTTP', async () => {
    assert.equal((await call('POST', '/fs/files', { path: '/', name: 'nuevo.txt' })).statusCode, 201);
    assert.equal(code(await call('POST', '/fs/files', { path: '/', name: 'NUEVO.txt' })), 'CONFLICT');
    assert.equal((await call('POST', '/fs/rename', { path: '/nuevo.txt', name: 'renombrado.txt' })).json().path, '/renombrado.txt');
    const copy = (await call('POST', '/fs/copy', { paths: ['/Fotos'], destination: '/' })).json() as BatchResponse;
    assert.equal(copy.results[0]?.ok && copy.results[0].path, '/Fotos (2)');
    const move = (await call('POST', '/fs/move', { paths: ['/renombrado.txt'], destination: '/Fotos (2)' })).json() as BatchResponse;
    assert.equal(move.results[0]?.ok && move.results[0].path, '/Fotos (2)/renombrado.txt');
    const trashed = (await call('POST', '/fs/trash', { paths: ['/Fotos (2)'] })).json() as BatchResponse;
    assert.ok(trashed.results[0]?.ok);
    const list = (await call('GET', '/trash')).json() as TrashListResponse;
    assert.equal(list.entries.length, 1);
    assert.equal(list.retentionDays, 30);
    const restored = (await call('POST', '/trash/restore', { ids: [list.entries[0]?.id] })).json() as BatchResponse;
    assert.equal(restored.results[0]?.ok && restored.results[0].path, '/Fotos (2)');
    assert.ok((await readdir(path.join(h.dataRoot, 'Fotos (2)'))).includes('renombrado.txt'));
  });

  it('la carpeta interna y las de sistema no se listan ni se pueden usar (root_relative ".")', async () => {
    for (const url of ['/fs/list?path=%2F.pcloud', '/fs/list?path=%2F.PCLOUD%2Ftrash', '/fs/list?path=%2FSystem%20Volume%20Information']) {
      assert.equal(code(await call('GET', url)), 'INVALID_PATH', url);
    }
    const moved = (await call('POST', '/fs/move', { paths: ['/nota.txt'], destination: '/.pcloud/trash' })).statusCode;
    assert.equal(moved, 400, 'no se puede mover nada a la papelera interna');
    assert.equal(code(await call('POST', '/fs/folders', { path: '/', name: '.pcloud' })), 'INVALID_NAME');
    assert.equal(code(await call('POST', '/fs/rename', { path: '/nota.txt', name: '$RECYCLE.BIN' })), 'INVALID_NAME');
    await mkdir(path.join(h.dataRoot, '.pcloud'), { recursive: true });
    const names = ((await call('GET', '/fs/list?path=%2F')).json() as { entries: Array<{ name: string }> }).entries.map((entry) => entry.name);
    assert.ok(!names.includes('.pcloud'), 'no se lista');
  });

  it('descargas: Content-Length exacto aunque el archivo crezca; rango sobre archivo vacío → 416', async () => {
    await writeFile(path.join(h.dataRoot, 'vacio.txt'), '');
    assert.equal((await call('GET', '/fs/download?path=%2Fvacio.txt', undefined, { range: 'bytes=-5' })).statusCode, 416);
    const full = await call('GET', '/fs/download?path=%2Fnota.txt');
    assert.equal(Number(full.headers['content-length']), full.rawPayload.length);
  });

  it('recientes: lo creado aparece y, si se elimina, desaparece', async () => {
    assert.equal((await call('POST', '/fs/folders', { path: '/', name: 'Reciente' })).statusCode, 201);
    const before = (await call('GET', '/fs/recent')).json() as { entries: Array<{ path: string; type: string }> };
    assert.ok(before.entries.some((entry) => entry.path === '/Reciente' && entry.type === 'dir'));
    const trashed = (await call('POST', '/fs/trash', { paths: ['/Reciente'] })).json() as BatchResponse;
    const after = (await call('GET', '/fs/recent')).json() as { entries: Array<{ path: string }> };
    assert.ok(!after.entries.some((entry) => entry.path === '/Reciente'), 'lo eliminado no aparece');
    const id = trashed.results[0]?.ok === true ? trashed.results[0].path.slice('trash:'.length) : '';
    await call('POST', '/trash/delete', { ids: [id] }); // no deja nada en la papelera para otros tests
  });

  it('validación estricta: campos desconocidos, lotes vacíos e ids de papelera mal formados → 400', async () => {
    assert.equal((await call('POST', '/fs/rename', { path: '/nota.txt', name: 'x.txt', extra: 1 })).statusCode, 400);
    assert.equal((await call('POST', '/fs/trash', { paths: [] })).statusCode, 400);
    assert.equal((await call('POST', '/trash/delete', { ids: ['../../data'] })).statusCode, 400);
  });

  it('el borrado definitivo es solo del propietario', async () => {
    const other = await call('POST', '/auth/login', { username: 'luis', password: PASSWORD });
    const luis = String(other.headers['set-cookie']).split(';')[0] as string;
    const denied = await app.inject({ method: 'POST', url: '/api/v1/trash/empty', headers: { ...CSRF, cookie: luis } });
    assert.equal(denied.statusCode, 403);
    assert.equal((await call('POST', '/trash/empty')).json().removed, 0);
  });

  it('vista en línea: texto como text/plain aislado; tipos desconocidos siempre como adjunto', async () => {
    const text = await call('GET', '/fs/download?path=%2Fnota.txt&inline=1');
    assert.equal(text.headers['content-type'], 'text/plain; charset=utf-8');
    assert.match(String(text.headers['content-disposition']), /^inline/);
    assert.match(String(text.headers['content-security-policy']), /sandbox/);
    assert.equal(text.headers['x-frame-options'], 'SAMEORIGIN');
    await writeFile(path.join(h.dataRoot, 'programa.exe'), 'MZ');
    const binary = await call('GET', '/fs/download?path=%2Fprograma.exe&inline=1');
    assert.equal(binary.headers['content-type'], 'application/octet-stream');
    assert.match(String(binary.headers['content-disposition']), /^attachment/);
  });

  it('ZIP de una selección con Content-Length exacto', async () => {
    const response = await call('GET', '/fs/zip?dir=%2F&names=Fotos%2Fnota.txt');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'application/zip');
    assert.equal(Number(response.headers['content-length']), response.rawPayload.length);
    assert.match(String(response.headers['content-disposition']), /Archivos\.zip/);
  });

  it('actividad: el propietario ve todo; filtro por prefijo y paginación', async () => {
    const page = (await call('GET', '/activity?limit=3&action=fs.')).json() as { entries: Array<{ action: string }>; nextBefore: number | null };
    assert.equal(page.entries.length, 3);
    assert.ok(page.entries.every((entry) => entry.action.startsWith('fs.')));
    assert.ok(page.nextBefore !== null);
  });

  it('contraseña: exige la actual y cierra las demás sesiones', async () => {
    const second = await call('POST', '/auth/login', { username: 'ana', password: PASSWORD });
    const otherCookie = String(second.headers['set-cookie']).split(';')[0] as string;
    assert.equal(code(await call('POST', '/auth/password', { currentPassword: 'mala', newPassword: 'otra frase larga y segura' })), 'FORBIDDEN');
    assert.equal((await call('POST', '/auth/password', { currentPassword: PASSWORD, newPassword: 'otra frase larga y segura' })).statusCode, 204);
    currentPassword = 'otra frase larga y segura';
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { cookie: otherCookie } })).statusCode, 401);
    assert.equal((await call('GET', '/auth/me')).statusCode, 200, 'la sesión actual sigue');
    const sessions = (await call('GET', '/auth/sessions')).json() as { sessions: Array<{ current: boolean }> };
    assert.equal(sessions.sessions.filter((item) => item.current).length, 1);
  });

  for (const kind of ['es256', 'ed25519'] as const) {
    it(`passkey ${kind}: registrar, entrar sin contraseña y rechazar firmas falsas o reutilizadas`, async () => {
      const authenticator = new SoftAuthenticator(kind);
      const origin = 'http://localhost';
      assert.equal((await call('POST', '/auth/passkeys/register/options', { password: 'no es la contraseña' })).statusCode, 403, 'exige la contraseña');
      const options = (await call('POST', '/auth/passkeys/register/options', { password: currentPassword })).json() as PasskeyRegisterOptions;
      assert.equal(options.rp.id, 'localhost');
      const registration = await call('POST', '/auth/passkeys/register', { name: `Portátil ${kind}`, ...authenticator.register(options.challenge, origin, 'localhost') });
      assert.equal(registration.statusCode, 201, registration.body);

      const loginOptions = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login/options', headers: { ...CSRF, host: 'localhost' } })).json() as PasskeyLoginOptions;
      const assertion = authenticator.login(loginOptions.challenge, origin, 'localhost');
      const ok = await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login', headers: { ...CSRF, host: 'localhost' }, payload: assertion });
      assert.equal(ok.statusCode, 200, ok.body);
      assert.equal(ok.json().username, 'ana');
      assert.match(String(ok.headers['set-cookie']), /pcloud_session=.*HttpOnly/);

      const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login', headers: { ...CSRF, host: 'localhost' }, payload: assertion });
      assert.equal(replay.statusCode, 401, 'el reto es de un solo uso');

      const fresh = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login/options', headers: { ...CSRF, host: 'localhost' } })).json() as PasskeyLoginOptions;
      const forged = authenticator.login(fresh.challenge, origin, 'localhost');
      const tampered = { ...forged, signature: Buffer.from(forged.signature, 'base64url').reverse().toString('base64url') };
      assert.notEqual((await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login', headers: { ...CSRF, host: 'localhost' }, payload: tampered })).statusCode, 200);

      const evil = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login/options', headers: { ...CSRF, host: 'localhost' } })).json() as PasskeyLoginOptions;
      const phishing = authenticator.login(evil.challenge, 'https://evil.example', 'localhost');
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login', headers: { ...CSRF, host: 'localhost' }, payload: phishing })).statusCode, 403, 'origen ajeno');

      const noUv = (await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login/options', headers: { ...CSRF, host: 'localhost' } })).json() as PasskeyLoginOptions;
      const withoutBiometrics = authenticator.login(noUv.challenge, origin, 'localhost', 0x01);
      assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login', headers: { ...CSRF, host: 'localhost' }, payload: withoutBiometrics })).statusCode, 403, 'sin verificación de usuario');

      const list = (await call('GET', '/auth/passkeys')).json() as { passkeys: Array<{ id: string }> };
      assert.equal(list.passkeys.length, 1);
      assert.equal((await call('DELETE', `/auth/passkeys/${list.passkeys[0]?.id}`)).statusCode, 204);
    });
  }

  it('passkeys: no se ofrecen al entrar por dirección IP', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/passkeys/login/options', headers: { ...CSRF, host: '192.168.1.50' } });
    assert.equal(response.statusCode, 400);
  });
});
