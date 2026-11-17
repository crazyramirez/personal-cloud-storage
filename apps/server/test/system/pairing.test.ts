import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createSession } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import { deviceFolder, PAIRING_MAX_FAILURES, PairingService } from '../../src/system/pairing.ts';
import { createHarness, insertUser, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };
const SHARE = { share: 'Copias', user: 'pcloud-smb', password: 'abcdefghijkmnpqrstuvwxyz' };

describe('emparejar un ordenador con la carpeta de red (ADR-0022)', () => {
  let h: Harness;
  let app: FastifyInstance;
  let file = '';
  let pairing: PairingService;
  let now = new Date('2026-11-17T10:00:00.000Z');
  let owner = '';
  let member = '';

  before(async () => {
    h = await createHarness();
    file = path.join(h.root, 'smb.json');
    pairing = new PairingService(file);
    app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false, pairing, clock: () => now });
    owner = `pcloud_session=${createSession(h.db, insertUser(h.db, 'ana', 'owner'), {}, new Date())}`;
    member = `pcloud_session=${createSession(h.db, insertUser(h.db, 'luis', 'user'), {}, new Date())}`;
  });
  after(async () => {
    await app.close();
    await h.dispose();
  });
  beforeEach(() => {
    pairing.cancel();
    now = new Date(now.getTime() + 60 * 60 * 1000); // ventana nueva del límite por IP
  });

  const newCode = async (): Promise<string> => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/pairing/code', headers: { ...CSRF, cookie: owner } });
    assert.equal(response.statusCode, 200);
    return String(response.json().code);
  };
  const claim = (code: string, device = 'Portátil de Ana') =>
    app.inject({ method: 'POST', url: '/api/v1/pairing/claim', headers: CSRF, payload: { code, device } });

  it('sin carpeta de red instalada no hay códigos', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/pairing', headers: { cookie: owner } });
    assert.equal(status.json().available, false);
    const code = await app.inject({ method: 'POST', url: '/api/v1/pairing/code', headers: { ...CSRF, cookie: owner } });
    assert.equal(code.statusCode, 409);
    assert.equal((await claim('123456')).statusCode, 404);
    await writeFile(file, JSON.stringify(SHARE));
  });

  it('solo el propietario pide códigos', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pairing', headers: { cookie: member } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/pairing/code', headers: { ...CSRF, cookie: member } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/pairing/code', headers: { cookie: owner } })).statusCode, 403, 'sin cabecera anti-CSRF');
  });

  it('el código correcto da las credenciales una sola vez', async () => {
    const code = await newCode();
    assert.match(code, /^[0-9]{6}$/);
    const status = await app.inject({ method: 'GET', url: '/api/v1/pairing', headers: { cookie: owner } });
    assert.equal(status.json().code, code);
    assert.equal(status.json().available, true);
    const ok = await claim(code);
    assert.equal(ok.statusCode, 200);
    const body = ok.json() as Record<string, unknown>;
    assert.equal(typeof body['host'], 'string');
    assert.deepEqual({ ...body, host: '' }, { host: '', ...SHARE, folder: 'Portátil de Ana' });
    assert.equal((await claim(code)).statusCode, 403, 'ya gastado');
  });

  it('caduca a los 10 minutos', async () => {
    const code = await newCode();
    now = new Date(now.getTime() + 10 * 60 * 1000 + 1);
    assert.equal((await claim(code)).statusCode, 403);
  });

  it('pedir otro código anula el anterior', async () => {
    const first = await newCode();
    let second = await newCode();
    while (second === first) second = await newCode();
    assert.equal((await claim(first)).statusCode, 403);
    assert.equal((await claim(second)).statusCode, 200);
  });

  it(`${PAIRING_MAX_FAILURES} fallos invalidan el código`, async () => {
    const code = await newCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < PAIRING_MAX_FAILURES; i++) assert.equal((await claim(wrong)).statusCode, 403);
    assert.equal((await claim(code)).statusCode, 403);
  });

  it('rechaza códigos mal formados', async () => {
    assert.equal((await claim('12345')).statusCode, 400);
    assert.equal((await claim('abcdef')).statusCode, 400);
  });

  it('nombre de carpeta seguro para el equipo', () => {
    assert.equal(deviceFolder('PC de Ana'), 'PC de Ana');
    assert.equal(deviceFolder('../../etc'), 'etc');
    assert.equal(deviceFolder('a/b\\c:d*?'), 'abcd');
    assert.equal(deviceFolder('...'), 'Ordenador');
    assert.equal(deviceFolder('  fin.  '), 'fin');
  });
});
