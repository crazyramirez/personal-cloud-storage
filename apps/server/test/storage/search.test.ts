import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { FsSearchResponse } from '@pcloud/contracts';
import { hashPassword } from '../../src/auth/passwords.ts';
import { createUser } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import { searchTokens, searchTree } from '../../src/storage/search.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const PASSWORD = 'una frase larga y segura';

describe('búsqueda en la carpeta y sus subcarpetas', () => {
  let h: Harness;
  let app: FastifyInstance;
  let cookie = '';

  before(async () => {
    h = await createHarness();
    const d = h.dataRoot;
    await mkdir(path.join(d, 'Fotos', 'Viaje 2026', 'Playa'), { recursive: true });
    await mkdir(path.join(d, 'Documentos', 'Canciones'), { recursive: true });
    await writeFile(path.join(d, 'Fotos', 'viaje-portada.jpg'), 'jpg!');
    await writeFile(path.join(d, 'Fotos', 'Viaje 2026', 'Playa', 'atardecer en la playa.jpg'), 'x');
    await writeFile(path.join(d, 'Documentos', 'Canciones', 'canción de verano.mp3'), 'mp3');
    await writeFile(path.join(d, 'Documentos', 'presupuesto viaje.pdf'), 'pdf');
    createUser(h.db, 'ana', await hashPassword(PASSWORD), 'owner', new Date());
    app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-pcloud-request': '1', host: 'localhost' }, payload: { username: 'ana', password: PASSWORD } });
    cookie = String(login.headers['set-cookie']).split(';')[0] as string;
  });

  after(async () => {
    await app.close();
    await h.dispose();
  });

  const search = async (p: string, q: string, limit?: number): Promise<FsSearchResponse> => {
    const query = new URLSearchParams({ path: p, q, ...(limit === undefined ? {} : { limit: String(limit) }) });
    const response = await app.inject({ method: 'GET', url: `/api/v1/fs/search?${query}`, headers: { cookie, host: 'localhost' } });
    assert.equal(response.statusCode, 200, response.body);
    return response.json() as FsSearchResponse;
  };

  it('encuentra en todas las subcarpetas, sin mayúsculas ni acentos, lo más cercano primero', async () => {
    const result = await search('/', 'VIAJE');
    assert.deepEqual(result.results.map((item) => item.path), ['/Fotos/Viaje 2026', '/Documentos/presupuesto viaje.pdf', '/Fotos/viaje-portada.jpg']);
    assert.equal(result.truncated, null);
    const photo = result.results.find((item) => item.name === 'viaje-portada.jpg');
    assert.deepEqual({ dir: photo?.dir, type: photo?.type, size: photo?.size }, { dir: '/Fotos', type: 'file', size: 4 });
    assert.equal(result.results.find((item) => item.name === 'Viaje 2026')?.type, 'dir');
    assert.deepEqual((await search('/', 'cancion')).results.map((item) => item.path), ['/Documentos/Canciones', '/Documentos/Canciones/canción de verano.mp3']);
  });

  it('solo dentro de la carpeta pedida; varias palabras = todas, en cualquier orden', async () => {
    assert.deepEqual((await search('/Fotos', 'viaje')).results.map((item) => item.path), ['/Fotos/Viaje 2026', '/Fotos/viaje-portada.jpg']);
    assert.deepEqual((await search('/', 'playa atardecer')).results.map((item) => item.path), ['/Fotos/Viaje 2026/Playa/atardecer en la playa.jpg']);
    assert.deepEqual((await search('/', 'playa invierno')).results, []);
  });

  it('con el máximo alcanzado lo dice (truncated = limit)', async () => {
    const result = await search('/', 'a', 2);
    assert.equal(result.results.length, 2);
    assert.equal(result.truncated, 'limit');
  });

  it('se corta por tiempo y lo dice (truncated = time)', async () => {
    let calls = 0;
    const result = await searchTree(h.dataRoot, '/', 'viaje', { now: () => (calls++ === 0 ? 0 : 1e9) });
    assert.equal(result.truncated, 'time');
  });

  it('nunca muestra la carpeta interna ni sale de la raíz; rutas no válidas → error', async () => {
    assert.ok(!(await search('/', 'pcloud')).results.some((item) => item.path.toLowerCase().includes('.pcloud')));
    const bad = await app.inject({ method: 'GET', url: '/api/v1/fs/search?path=%2F..%2F&q=x', headers: { cookie, host: 'localhost' } });
    assert.equal(bad.statusCode, 400);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/fs/search?path=%2Fno-existe&q=x', headers: { cookie, host: 'localhost' } });
    assert.equal(missing.statusCode, 404);
    const empty = await app.inject({ method: 'GET', url: '/api/v1/fs/search?path=%2F&q=', headers: { cookie, host: 'localhost' } });
    assert.equal(empty.statusCode, 400);
  });

  it('sin disco → 503, nunca una lista vacía', async () => {
    h.gate.disconnect();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/v1/fs/search?path=%2F&q=viaje', headers: { cookie, host: 'localhost' } });
      assert.equal(response.statusCode, 503);
    } finally {
      h.gate.reconnect();
    }
  });

  it('palabras de la búsqueda', () => {
    assert.deepEqual(searchTokens('  Canción   de  VERANO '), ['cancion', 'de', 'verano']);
    assert.deepEqual(searchTokens('   '), []);
  });
});
