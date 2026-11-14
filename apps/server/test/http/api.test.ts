import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ApiErrorBody, FsListResponse, StorageResponse, UploadInitResponse } from '@pcloud/contracts';
import { hashPassword, verifyPassword } from '../../src/auth/passwords.ts';
import { consumeSetupToken, createSession, createUser, findSession, issueSetupToken, ownerExists, revokeSession } from '../../src/auth/sessions.ts';
import { openDatabase } from '../../src/db/database.ts';
import { buildApp, localName } from '../../src/http/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };
const PASSWORD = 'una frase larga y segura';

function errorCode(response: LightMyRequestResponse): string {
  return (response.json() as ApiErrorBody).error.code;
}

describe('contraseñas y sesiones', () => {
  it('Argon2id: verifica la correcta, rechaza la incorrecta y los hashes malformados', async () => {
    const hash = await hashPassword(PASSWORD);
    assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    assert.equal(await verifyPassword(PASSWORD, hash), true);
    assert.equal(await verifyPassword('otra contraseña', hash), false);
    assert.notEqual(await hashPassword(PASSWORD), hash, 'sal aleatoria: dos hashes de lo mismo difieren');
    for (const bad of ['', 'x', '$argon2id$v=19$m=65536,t=3,p=1$sal$hash', hash.replace('m=65536', 'm=99999999')]) {
      assert.equal(await verifyPassword(PASSWORD, bad), false);
    }
  });

  it('sesiones: token opaco, hash en base, caducidad y revocación', async () => {
    const db = await openDatabase(':memory:');
    const now = new Date('2026-11-14T10:00:00Z');
    const userId = createUser(db, 'ana', 'hash', 'owner', now);
    const token = createSession(db, userId, { ip: '192.168.1.10' }, now);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get(token)?.['n'], 0, 'el token en claro no se guarda');
    assert.deepEqual(findSession(db, token, now), { userId, username: 'ana', role: 'owner' });
    assert.equal(findSession(db, `${token}x`, now), null);
    assert.equal(findSession(db, token, new Date('2026-12-20T10:00:00Z')), null, 'caduca a los 30 días');
    revokeSession(db, token, now);
    assert.equal(findSession(db, token, now), null);
    db.close();
  });

  it('código de configuración: un solo uso, caduca y admite formato con o sin guiones', async () => {
    const db = await openDatabase(':memory:');
    const now = new Date('2026-11-14T10:00:00Z');
    const first = issueSetupToken(db, now);
    assert.match(first, /^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    const second = issueSetupToken(db, now);
    assert.equal(consumeSetupToken(db, first, now), false, 'emitir uno nuevo invalida el anterior');
    assert.equal(consumeSetupToken(db, second, new Date('2026-11-15T10:00:01Z')), false, 'caduca a las 24 h');
    assert.equal(consumeSetupToken(db, second.toLowerCase().replaceAll('-', ' '), now), true);
    assert.equal(consumeSetupToken(db, second, now), false, 'no se puede usar dos veces');
    assert.equal(ownerExists(db), false);
    db.close();
  });
});

describe('API v1 de extremo a extremo', () => {
  let h: Harness;
  let app: FastifyInstance;
  let cookie = '';

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'HEAD', url: string, options: { body?: unknown; headers?: Record<string, string>; payload?: Buffer; anonymous?: boolean } = {}) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(method === 'GET' || method === 'HEAD' ? {} : CSRF),
        ...(options.anonymous === true || cookie === '' ? {} : { cookie }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { payload: options.body as object }),
      ...(options.payload === undefined ? {} : { payload: options.payload }),
    });

  before(async () => {
    h = await createHarness();
    app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false });
  });
  after(async () => {
    await app.close();
    await h.dispose();
  });

  it('health es público; el resto exige sesión', async () => {
    const health = await call('GET', '/system/health');
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().volumeState, 'READY');
    for (const url of ['/system/storage', '/auth/me', '/fs/list?path=/', '/fs/download?path=/a']) {
      const response = await call('GET', url);
      assert.equal(response.statusCode, 401, url);
      assert.equal(errorCode(response), 'UNAUTHENTICATED');
    }
    assert.equal((await call('GET', '/no/existe')).statusCode, 401, 'tampoco revela qué rutas existen');
  });

  it('configuración inicial: exige código válido y contraseña de 12+ caracteres', async () => {
    assert.deepEqual((await call('GET', '/setup/status')).json(), { needsOwner: true, localName: localName() });
    const token = issueSetupToken(h.db, new Date());

    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/setup/owner', payload: { token, username: 'ana', password: PASSWORD } });
    assert.equal(noCsrf.statusCode, 403, 'sin la cabecera anti-CSRF no se acepta');

    const weak = await call('POST', '/setup/owner', { body: { token, username: 'ana', password: 'corta' } });
    assert.equal(weak.statusCode, 400);
    const wrong = await call('POST', '/setup/owner', { body: { token: 'AAAAA-BBBBB-CCCCC-DDDDD', username: 'ana', password: PASSWORD } });
    assert.equal(wrong.statusCode, 403);
    assert.equal(ownerExists(h.db), false);

    const created = await call('POST', '/setup/owner', { body: { token, username: 'ana', password: PASSWORD } });
    assert.equal(created.statusCode, 201);
    assert.deepEqual(created.json(), { username: 'ana', role: 'owner' });
    const setCookie = String(created.headers['set-cookie']);
    assert.match(setCookie, /pcloud_session=[^;]+; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict/);
    cookie = setCookie.split(';')[0] ?? '';

    assert.deepEqual((await call('GET', '/setup/status')).json(), { needsOwner: false, localName: localName() });
    const again = await call('POST', '/setup/owner', { body: { token, username: 'otro', password: PASSWORD } });
    assert.equal(again.statusCode, 409, 'solo puede haber una configuración inicial');
    assert.deepEqual((await call('GET', '/auth/me')).json(), { username: 'ana', role: 'owner' });
  });

  it('login: credenciales incorrectas → 401 genérico; correctas → sesión nueva; logout la revoca', async () => {
    for (const body of [{ username: 'ana', password: 'incorrecta-incorrecta' }, { username: 'nadie', password: PASSWORD }]) {
      const response = await call('POST', '/auth/login', { body, anonymous: true });
      assert.equal(response.statusCode, 401);
      assert.equal((response.json() as ApiErrorBody).error.message, 'Usuario o contraseña incorrectos');
    }
    const ok = await call('POST', '/auth/login', { body: { username: 'ANA', password: PASSWORD }, anonymous: true });
    assert.equal(ok.statusCode, 200, 'el usuario no distingue mayúsculas');
    const second = String(ok.headers['set-cookie']).split(';')[0] ?? '';
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: second } })).statusCode, 200);
    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...CSRF, cookie: second } });
    assert.equal((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: second } })).statusCode, 401);
  });

  it('explorador: crea carpetas, lista y rechaza nombres y rutas inválidos', async () => {
    assert.equal((await call('POST', '/fs/folders', { body: { path: '/', name: 'Proyectos' } })).statusCode, 201);
    assert.equal(errorCode(await call('POST', '/fs/folders', { body: { path: '/', name: 'proyectos' } })), 'CONFLICT');
    assert.equal(errorCode(await call('POST', '/fs/folders', { body: { path: '/', name: 'CON' } })), 'INVALID_NAME');
    assert.equal(errorCode(await call('POST', '/fs/folders', { body: { path: '/../', name: 'x' } })), 'INVALID_PATH');
    assert.equal(errorCode(await call('GET', '/fs/list?path=/%2E%2E/')), 'INVALID_PATH', 'traversal codificado');
    assert.equal(errorCode(await call('GET', '/fs/list?path=/no-existe')), 'NOT_FOUND');
    assert.equal((await call('GET', '/fs/list?path=/&limit=5000')).statusCode, 400);
    await writeFile(path.join(h.dataRoot, 'notas.txt'), 'hola');
    const listing = (await call('GET', '/fs/list?path=/')).json() as FsListResponse;
    assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.type, entry.size]), [['Proyectos', 'dir', 0], ['notas.txt', 'file', 4]]);
  });

  it('subida reanudable completa por HTTP y descarga idéntica con Range', async () => {
    const data = randomBytes(200 * 1024);
    const init = await call('POST', '/uploads', { body: { path: '/Proyectos', name: 'vídeo final.bin', size: data.length } });
    assert.equal(init.statusCode, 201, init.body);
    const { id, chunkSize } = init.json() as UploadInitResponse;

    let offset = 0;
    while (offset < data.length) {
      const block = data.subarray(offset, offset + chunkSize);
      const patch = await call('PATCH', `/uploads/${id}`, {
        payload: block,
        headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': String(offset) },
      });
      assert.equal(patch.statusCode, 204, patch.body);
      offset = Number(patch.headers['upload-offset']);
    }
    const stale = await call('PATCH', `/uploads/${id}`, {
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal((stale.json() as ApiErrorBody).error.details?.['offset'], data.length, 'el servidor indica desde dónde continuar');
    assert.equal((await call('GET', `/uploads/${id}`)).json().offset, data.length);

    const done = await call('POST', `/uploads/${id}/complete`);
    assert.equal(done.statusCode, 200, done.body);
    assert.equal(done.json().path, '/Proyectos/vídeo final.bin');
    assert.deepEqual(await readFile(path.join(h.dataRoot, 'Proyectos', 'vídeo final.bin')), data);

    const url = `/fs/download?path=${encodeURIComponent('/Proyectos/vídeo final.bin')}`;
    const full = await call('GET', url);
    assert.equal(full.statusCode, 200);
    assert.deepEqual(full.rawPayload, data);
    assert.equal(full.headers['content-type'], 'application/octet-stream');
    assert.equal(full.headers['x-content-type-options'], 'nosniff');
    assert.match(String(full.headers['content-security-policy']), /sandbox/);
    assert.match(String(full.headers['content-disposition']), /^attachment; filename="v_deo final\.bin"; filename\*=UTF-8''v%C3%ADdeo%20final\.bin$/);
    const etag = String(full.headers.etag);

    const part = await call('GET', url, { headers: { range: 'bytes=1000-1999' } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers['content-range'], `bytes 1000-1999/${data.length}`);
    assert.deepEqual(part.rawPayload, data.subarray(1000, 2000));
    const tail = await call('GET', url, { headers: { range: 'bytes=-100' } });
    assert.deepEqual(tail.rawPayload, data.subarray(data.length - 100));
    const resume = await call('GET', url, { headers: { range: `bytes=${data.length - 10}-` } });
    assert.deepEqual(resume.rawPayload, data.subarray(data.length - 10));
    assert.equal((await call('GET', url, { headers: { range: `bytes=${data.length}-` } })).statusCode, 416);
    assert.equal((await call('GET', url, { headers: { 'if-none-match': etag } })).statusCode, 304);
    const changed = await call('GET', url, { headers: { range: 'bytes=0-9', 'if-range': '"otro"' } });
    assert.equal(changed.statusCode, 200, 'si el archivo cambió, If-Range obliga a enviarlo completo');
    assert.equal((await call('GET', '/fs/download?path=/Proyectos')).statusCode, 404, 'una carpeta no se descarga');
  });

  it('el estado del almacenamiento incluye el espacio y la reserva', async () => {
    const storage = (await call('GET', '/system/storage')).json() as StorageResponse;
    assert.equal(storage.state, 'READY');
    assert.ok(storage.space !== null && storage.space.totalBytes > 0 && storage.space.freeBytes > 0);
    assert.ok(!('identity' in storage), 'la identidad interna del montaje no se publica');
  });

  it('disco desconectado: 503 STORAGE_UNAVAILABLE en todo lo que toca ficheros, y nada se escribe', async () => {
    const before = await readdir(h.dataRoot);
    h.gate.disconnect();
    try {
      const requests = [
        await call('GET', '/fs/list?path=/'),
        await call('GET', '/fs/download?path=/notas.txt'),
        await call('POST', '/fs/folders', { body: { path: '/', name: 'Nueva' } }),
        await call('POST', '/uploads', { body: { path: '/', name: 'a.txt', size: 1 } }),
      ];
      for (const response of requests) {
        assert.equal(response.statusCode, 503);
        const body = response.json() as ApiErrorBody;
        assert.equal(body.error.code, 'STORAGE_UNAVAILABLE');
        assert.equal(body.error.retryable, true);
        assert.equal(body.error.details?.['volumeState'], 'UNAVAILABLE');
        assert.match(body.error.requestId, /^[0-9a-f-]{36}$/);
      }
      const storage = (await call('GET', '/system/storage')).json() as StorageResponse;
      assert.equal(storage.state, 'UNAVAILABLE', 'la API sigue viva y explica el estado');
      assert.equal(storage.space, null);
      assert.equal((await call('GET', '/auth/me')).statusCode, 200);
    } finally {
      h.gate.reconnect();
    }
    assert.deepEqual(await readdir(h.dataRoot), before);
    assert.equal((await call('GET', '/fs/list?path=/')).statusCode, 200, 'al volver el disco, todo funciona de nuevo');
  });

  it('solo lectura: se puede listar y descargar, no modificar', async () => {
    h.gate.state = 'READ_ONLY';
    try {
      assert.equal((await call('GET', '/fs/list?path=/')).statusCode, 200);
      assert.equal((await call('GET', '/fs/download?path=/notas.txt')).statusCode, 200);
      assert.equal((await call('POST', '/fs/folders', { body: { path: '/', name: 'Otra' } })).statusCode, 503);
    } finally {
      h.gate.state = 'READY';
    }
  });

  it('limita los intentos de login por IP', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await call('POST', '/auth/login', { body: { username: 'ana', password: 'incorrecta-incorrecta' }, anonymous: true })).statusCode;
    }
    assert.equal(last, 429);
  });

  it('una carpeta con un nombre de archivo en conflicto no impide subir: se guarda con otro nombre', async () => {
    await mkdir(path.join(h.dataRoot, 'duplicado.txt'));
    const init = (await call('POST', '/uploads', { body: { path: '/', name: 'duplicado.txt', size: 3 } })).json() as UploadInitResponse;
    await call('PATCH', `/uploads/${init.id}`, { payload: Buffer.from('abc'), headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' } });
    const done = await call('POST', `/uploads/${init.id}/complete`);
    assert.equal(done.json().name, 'duplicado (2).txt');
  });
});
