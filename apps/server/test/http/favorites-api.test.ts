import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { MAX_FAVORITES, type ApiErrorBody, type BatchResponse, type FavoriteListResponse } from '@pcloud/contracts';
import { hashPassword } from '../../src/auth/passwords.ts';
import { createUser } from '../../src/auth/sessions.ts';
import { FavoriteStore } from '../../src/favorites/store.ts';
import { buildApp } from '../../src/http/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };
const PASSWORD = 'una frase larga y segura';

describe('favoritos (ADR-0027)', () => {
  let h: Harness;
  let app: FastifyInstance;
  let ana = '';
  let luis = '';

  const call = (cookie: string, method: 'GET' | 'POST', url: string, body?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...(method === 'GET' ? {} : CSRF), cookie, host: 'localhost' },
      ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
    });
  const list = async (cookie = ana): Promise<FavoriteListResponse> => (await call(cookie, 'GET', '/favorites')).json() as FavoriteListResponse;
  const paths = async (cookie = ana): Promise<string[]> => (await list(cookie)).entries.map((entry) => entry.path);
  const login = async (username: string): Promise<string> => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { ...CSRF, host: 'localhost' }, payload: { username, password: PASSWORD } });
    return String(response.headers['set-cookie']).split(';')[0] as string;
  };

  before(async () => {
    h = await createHarness();
    createUser(h.db, 'ana', await hashPassword(PASSWORD), 'owner', new Date());
    createUser(h.db, 'luis', await hashPassword(PASSWORD), 'user', new Date());
    app = await buildApp({ config: { ...h.config, trash: { enabled: true, retentionDays: 30 } }, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false });
    ana = await login('ana');
    luis = await login('luis');
    await mkdir(path.join(h.dataRoot, 'Fotos', 'Viaje'), { recursive: true });
    await mkdir(path.join(h.dataRoot, 'Destino'));
    await writeFile(path.join(h.dataRoot, 'Fotos', 'Viaje', 'playa.jpg'), 'jpg!');
    await writeFile(path.join(h.dataRoot, 'nota.txt'), 'hola');
  });

  after(async () => {
    await app.close();
    await h.dispose();
  });

  it('añadir carpetas y archivos: tipo, tamaño y lo último marcado primero', async () => {
    assert.equal((await call(ana, 'POST', '/favorites', { paths: ['/Fotos'] })).statusCode, 200);
    const response = await call(ana, 'POST', '/favorites', { paths: ['/Fotos/Viaje/playa.jpg', '/nota.txt'] });
    assert.equal(response.statusCode, 200);
    const body = response.json() as FavoriteListResponse;
    assert.equal(body.max, MAX_FAVORITES);
    assert.deepEqual(body.entries.map((entry) => entry.path), ['/nota.txt', '/Fotos/Viaje/playa.jpg', '/Fotos']);
    const photo = body.entries.find((entry) => entry.name === 'playa.jpg');
    assert.deepEqual({ type: photo?.type, size: photo?.size, dir: photo?.dir, exists: photo?.exists }, { type: 'file', size: 4, dir: '/Fotos/Viaje', exists: true });
    assert.equal(body.entries.find((entry) => entry.path === '/Fotos')?.type, 'dir');
  });

  it('añadir otra vez es idempotente y conserva la fecha', async () => {
    const before = (await list()).entries.find((entry) => entry.path === '/Fotos')?.addedAt;
    await call(ana, 'POST', '/favorites', { paths: ['/Fotos', '/Fotos'] });
    const entries = (await list()).entries.filter((entry) => entry.path === '/Fotos');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.addedAt, before);
  });

  it('cada usuario tiene los suyos', async () => {
    assert.deepEqual(await paths(luis), []);
    await call(luis, 'POST', '/favorites', { paths: ['/nota.txt'] });
    assert.deepEqual(await paths(luis), ['/nota.txt']);
    assert.equal((await paths(ana)).length, 3);
    await call(luis, 'POST', '/favorites/remove', { paths: ['/nota.txt'] });
    assert.deepEqual(await paths(luis), []);
    assert.ok((await paths(ana)).includes('/nota.txt'), 'quitar el de otro usuario no toca los tuyos');
  });

  it('rechaza lo que no existe, la raíz, la carpeta interna y campos de más', async () => {
    const missing = await call(ana, 'POST', '/favorites', { paths: ['/no-existe'] });
    assert.equal(missing.statusCode, 404);
    assert.equal((await call(ana, 'POST', '/favorites', { paths: ['/'] })).statusCode, 400);
    assert.equal(((await call(ana, 'POST', '/favorites', { paths: ['/'] })).json() as ApiErrorBody).error.code, 'INVALID_PATH');
    assert.equal((await call(ana, 'POST', '/favorites', { paths: ['/../etc'] })).statusCode, 400);
    assert.equal((await call(ana, 'POST', '/favorites', { paths: [] })).statusCode, 400);
    assert.equal((await call(ana, 'POST', '/favorites', { paths: ['/nota.txt'], extra: 1 })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/favorites', headers: { host: 'localhost' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/favorites', headers: { cookie: ana, host: 'localhost' }, payload: { paths: ['/nota.txt'] } })).statusCode, 403, 'sin cabecera CSRF');
    assert.equal((await paths()).length, 3, 'un lote con un error no añade nada');
  });

  it('renombrar y mover desde la web: el favorito sigue al elemento (y lo de dentro)', async () => {
    assert.equal((await call(ana, 'POST', '/fs/rename', { path: '/Fotos', name: 'Álbum' })).statusCode, 200);
    let now = await paths();
    assert.ok(now.includes('/Álbum') && now.includes('/Álbum/Viaje/playa.jpg'));
    assert.ok(!now.some((p) => p.startsWith('/Fotos')));
    await call(ana, 'POST', '/fs/move', { paths: ['/Álbum/Viaje'], destination: '/Destino' });
    now = await paths();
    assert.ok(now.includes('/Destino/Viaje/playa.jpg'));
    assert.equal((await list()).entries.find((entry) => entry.path === '/Destino/Viaje/playa.jpg')?.exists, true);
  });

  it('a la papelera: sigue en la lista como «no disponible» y vuelve al restaurar', async () => {
    const trashed = (await call(ana, 'POST', '/fs/trash', { paths: ['/nota.txt'] })).json() as BatchResponse;
    assert.equal((await list()).entries.find((entry) => entry.path === '/nota.txt')?.exists, false);
    const id = trashed.results[0]?.ok === true ? trashed.results[0].path.slice('trash:'.length) : '';
    await call(ana, 'POST', '/trash/restore', { ids: [id] });
    assert.equal((await list()).entries.find((entry) => entry.path === '/nota.txt')?.exists, true);
  });

  it('sin disco: la lista se sirve (exists = null), quitar funciona y nada se borra solo', async () => {
    h.gate.disconnect();
    try {
      const body = await list();
      assert.equal(body.entries.length, 3);
      assert.ok(body.entries.every((entry) => entry.exists === null && entry.mtime === null));
      assert.equal(body.entries.find((entry) => entry.path === '/Álbum')?.type, 'dir', 'el tipo guardado');
      assert.equal((await call(ana, 'POST', '/favorites', { paths: ['/Destino'] })).statusCode, 503, 'añadir necesita el disco');
      assert.equal((await call(ana, 'POST', '/favorites/remove', { paths: ['/Álbum'] })).statusCode, 200);
      assert.equal((await paths()).length, 2);
    } finally {
      h.gate.reconnect();
    }
    assert.equal((await list()).entries.length, 2);
  });

  it('quitar algo que no es favorito no falla', async () => {
    const response = await call(ana, 'POST', '/favorites/remove', { paths: ['/nunca-fue-favorito'] });
    assert.equal(response.statusCode, 200);
  });

  it('límite por usuario: todo o nada', async () => {
    const store = new FavoriteStore(h.db);
    const userId = Number(h.db.prepare("SELECT id FROM users WHERE username = 'luis'").get()?.['id']);
    store.add(userId, Array.from({ length: MAX_FAVORITES - 1 }, (_, i) => ({ path: `/x${i}`, kind: 'file' as const })), new Date());
    const response = await call(luis, 'POST', '/favorites', { paths: ['/nota.txt', '/Destino'] });
    assert.equal(response.statusCode, 409);
    assert.equal((await paths(luis)).length, MAX_FAVORITES - 1);
    assert.equal((await call(luis, 'POST', '/favorites', { paths: ['/nota.txt'] })).statusCode, 200);
    assert.equal((await paths(luis)).length, MAX_FAVORITES);
  });
});
