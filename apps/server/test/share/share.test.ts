import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ShareCreateResponse, ShareListResponse } from '@pcloud/contracts';
import { createSession } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import { ShareGateway, type AgentReply, type GatewayAgent } from '../../src/share/gateway.ts';
import { buildGuestApp } from '../../src/share/guest-app.ts';
import { hashToken, ShareStore } from '../../src/share/store.ts';
import { createHarness, insertUser, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };
const silent = { info: () => undefined, warn: () => undefined };

class FakeAgent implements GatewayAgent {
  calls: Array<'on' | 'off'> = [];
  next: AgentReply | null = null;

  async ready(): Promise<boolean> {
    return true;
  }

  async request(action: 'on' | 'off'): Promise<AgentReply> {
    this.calls.push(action);
    const reply = this.next ?? { ok: true, code: action === 'on' ? 'ON' : 'OFF', url: action === 'on' ? 'https://pi.tail0.ts.net:8443' : undefined };
    this.next = null;
    return reply;
  }
}

describe('enlaces para compartir (ADR-0018)', () => {
  let h: Harness;
  let app: FastifyInstance;
  let guest: FastifyInstance;
  let store: ShareStore;
  let agent: FakeAgent;
  let gateway: ShareGateway;
  let owner = '';
  let member = '';

  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: object, who = owner) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { ...(method === 'GET' ? {} : CSRF), cookie: who }, ...(body === undefined ? {} : { payload: body }) });
  const share = async (body: object): Promise<ShareCreateResponse> => {
    const response = await api('POST', '/shares', body);
    assert.equal(response.statusCode, 201, response.body);
    await gateway.reconcile();
    return response.json() as ShareCreateResponse;
  };
  const visit = (url: string, headers: Record<string, string> = {}) => guest.inject({ method: 'GET', url, headers: { 'accept-language': 'es-ES,es;q=0.9', ...headers } });

  before(async () => {
    h = await createHarness();
    await mkdir(path.join(h.dataRoot, 'Películas', 'Extras'), { recursive: true });
    await writeFile(path.join(h.dataRoot, 'Películas', 'peli.mkv'), Buffer.alloc(10_000, 7));
    await writeFile(path.join(h.dataRoot, 'Películas', "Tom & Jerry's.txt"), 'hola');
    await writeFile(path.join(h.dataRoot, 'Películas', 'Extras', 'making-of.txt'), 'extra');
    await writeFile(path.join(h.dataRoot, 'secreto.txt'), 'no se comparte');
    store = new ShareStore(h.db);
    agent = new FakeAgent();
    gateway = new ShareGateway({ agent, activeCount: () => store.countActive(new Date()), log: silent });
    app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false, shares: { store, gateway } });
    guest = await buildGuestApp({ db: h.db, store, guardian: h.gate, logger: false, onShareChanged: () => void gateway.reconcile() });
    owner = `pcloud_session=${createSession(h.db, insertUser(h.db, 'ana', 'owner'), {}, new Date())}`;
    member = `pcloud_session=${createSession(h.db, insertUser(h.db, 'luis', 'user'), {}, new Date())}`;
  });
  after(async () => {
    await app.close();
    await guest.close();
    await h.dispose();
  });

  it('solo el propietario crea enlaces; nunca de la nube entera ni de algo que no existe', async () => {
    assert.equal((await api('POST', '/shares', { path: '/Películas/peli.mkv', expiresInDays: 7 }, member)).statusCode, 403);
    assert.equal((await api('GET', '/shares', undefined, member)).statusCode, 403);
    assert.equal((await api('POST', '/shares', { path: '/', expiresInDays: 7 })).statusCode, 400);
    assert.equal((await api('POST', '/shares', { path: '/no-existe.mkv', expiresInDays: 7 })).statusCode, 404);
    assert.equal((await api('POST', '/shares', { path: '/Películas/peli.mkv', expiresInDays: 90 })).statusCode, 400, 'como mucho 30 días');
    assert.equal((await api('POST', '/shares', { path: '/.pcloud', expiresInDays: 7 })).statusCode, 400, 'carpeta interna');
    assert.equal((await api('POST', '/shares', { path: '/Películas', expiresInDays: 7, maxDownloads: 3 })).statusCode, 400, 'sin límite de descargas en carpetas');
    assert.deepEqual(agent.calls, [], 'sin enlaces no se publica nada');
  });

  it('archivo: enlace con token de 256 bits (solo su hash en la base), página sin JavaScript y descarga', async () => {
    const created = await share({ path: '/Películas/peli.mkv', expiresInDays: 7 });
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shares WHERE token_hash = ?').get(created.token)?.['n'], 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM shares WHERE token_hash = ?').get(hashToken(created.token))?.['n'], 1);
    assert.deepEqual(agent.calls, ['on'], 'con el primer enlace se publica la puerta');
    assert.equal(gateway.view.state, 'on');
    assert.equal(gateway.view.url, 'https://pi.tail0.ts.net:8443');

    const pageResponse = await visit(`/s/${created.token}`);
    assert.equal(pageResponse.statusCode, 200);
    assert.match(pageResponse.body, /peli\.mkv/);
    assert.doesNotMatch(pageResponse.body, /<script/i);
    const csp = String(pageResponse.headers['content-security-policy']);
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
    assert.equal(pageResponse.headers['referrer-policy'], 'no-referrer');
    assert.match(String(pageResponse.headers['x-robots-tag']), /noindex/);

    const file = await visit(`/s/${created.token}/f`);
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.length, 10_000);
    assert.match(String(file.headers['content-disposition']), /^attachment; filename="peli\.mkv"/);
    assert.equal(file.headers['content-type'], 'application/octet-stream');
    assert.equal(store.get(created.share.id)?.downloads, 1);
    // ?p= no sirve para salir de un enlace de archivo.
    const escape = await visit(`/s/${created.token}/f?p=${encodeURIComponent('/../secreto.txt')}`);
    assert.equal(escape.rawPayload.length, 10_000, 'un enlace de archivo siempre sirve ese archivo');
  });

  it('las reanudaciones (Range) no cuentan como descarga nueva; HEAD no existe', async () => {
    const created = await share({ path: '/Películas/peli.mkv', expiresInDays: 1 });
    const part = await visit(`/s/${created.token}/f`, { range: 'bytes=5000-' });
    assert.equal(part.statusCode, 206);
    assert.equal(part.rawPayload.length, 5000);
    assert.equal(store.get(created.share.id)?.downloads, 0);
    const head = await guest.inject({ method: 'HEAD', url: `/s/${created.token}/f` });
    assert.equal(head.statusCode, 404);
  });

  it('límite de descargas: al agotarse responde igual que un enlace inexistente', async () => {
    const created = await share({ path: '/Películas/peli.mkv', expiresInDays: 7, maxDownloads: 1 });
    assert.match((await visit(`/s/${created.token}`)).body, /Queda 1 descarga/);
    assert.equal((await visit(`/s/${created.token}/f`)).statusCode, 200);
    const exhausted = await visit(`/s/${created.token}`);
    const unknown = await visit(`/s/${'A'.repeat(43)}`);
    assert.equal(exhausted.statusCode, 404);
    assert.equal(unknown.statusCode, 404);
    assert.equal(exhausted.body.replace(/nonce-[^"']+|nonce="[^"]+"/g, ''), unknown.body.replace(/nonce-[^"']+|nonce="[^"]+"/g, ''), 'sin pistas');
    assert.equal((await visit(`/s/${created.token}/f`)).statusCode, 404);
    const listed = (await api('GET', '/shares')).json() as ShareListResponse;
    assert.equal(listed.shares.find((s) => s.id === created.share.id)?.state, 'exhausted');
  });

  it('carpeta: lista, subcarpetas, nombres escapados, ZIP y nada fuera de lo compartido', async () => {
    const created = await share({ path: '/Películas', expiresInDays: 30 });
    const root = await visit(`/s/${created.token}`);
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /Tom &amp; Jerry&#39;s\.txt/, 'nombres escapados');
    assert.match(root.body, /Extras/);
    assert.doesNotMatch(root.body, /secreto/);
    const sub = await visit(`/s/${created.token}?p=${encodeURIComponent('/Extras')}`);
    assert.match(sub.body, /making-of\.txt/);
    const inner = await visit(`/s/${created.token}/f?p=${encodeURIComponent('/Extras/making-of.txt')}`);
    assert.equal(inner.body, 'extra');
    for (const bad of ['/../secreto.txt', '/Extras/../../secreto.txt', '..', '/./x', '\\..\\secreto.txt']) {
      const response = await visit(`/s/${created.token}/f?p=${encodeURIComponent(bad)}`);
      assert.equal(response.statusCode, 404, bad);
      assert.doesNotMatch(response.body, /no se comparte/);
    }
    const zip = await visit(`/s/${created.token}/zip`);
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.headers['content-type'], 'application/zip');
    assert.equal(zip.rawPayload.subarray(0, 4).readUInt32LE(0), 0x04034b50);
    assert.ok(zip.rawPayload.includes(Buffer.from('Extras/making-of.txt')));
    assert.ok(!zip.rawPayload.includes(Buffer.from('secreto')));
  });

  it('contraseña: formulario, intentos limitados y acceso con cookie del propio enlace', async () => {
    const created = await share({ path: '/Películas/peli.mkv', expiresInDays: 7, password: 'gato azul' });
    const locked = await visit(`/s/${created.token}`);
    assert.equal(locked.statusCode, 401);
    assert.match(locked.body, /<form method="post"/);
    assert.equal((await visit(`/s/${created.token}/f`)).statusCode, 401, 'sin contraseña no hay descarga');
    const post = (pin: string, ip = '203.0.113.7') =>
      guest.inject({ method: 'POST', url: `/s/${created.token}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': ip }, remoteAddress: '127.0.0.1', payload: `pin=${encodeURIComponent(pin)}` });
    const wrong = await post('perro');
    assert.equal(wrong.statusCode, 401);
    assert.match(wrong.body, /Wrong password/);
    const ok = await post('gato azul');
    assert.equal(ok.statusCode, 303);
    const setCookie = String(ok.headers['set-cookie']);
    assert.match(setCookie, new RegExp(`Path=/s/${created.token}`));
    assert.match(setCookie, /HttpOnly/);
    const grant = setCookie.split(';')[0] ?? '';
    assert.equal((await visit(`/s/${created.token}/f`, { cookie: grant })).statusCode, 200);
    // La cookie de un enlace no abre otro.
    const other = await share({ path: '/Películas/peli.mkv', expiresInDays: 7, password: 'gato azul' });
    assert.equal((await visit(`/s/${other.token}/f`, { cookie: grant })).statusCode, 401);
    // Fuerza bruta: 5 fallos desde una IP → bloqueada esa IP para ese enlace.
    for (let i = 0; i < 5; i += 1) await post(`mal-${i}`, '198.51.100.9');
    assert.equal((await post('gato azul', '198.51.100.9')).statusCode, 429);
    // Poner otra IP delante en X-Forwarded-For no sirve: solo cuenta la que añade tailscaled.
    assert.equal((await post('gato azul', '9.9.9.9, 198.51.100.9')).statusCode, 429);
    const otherIp = await post('gato azul', '192.0.2.50');
    assert.equal(otherIp.statusCode, 303, `otra IP sí puede: ${otherIp.statusCode} ${otherIp.body.slice(-400)}`);
  });

  it('sin disco: «no disponible ahora», nunca una carpeta vacía', async () => {
    const created = await share({ path: '/Películas', expiresInDays: 7 });
    h.gate.disconnect();
    try {
      const response = await visit(`/s/${created.token}`);
      assert.equal(response.statusCode, 503);
      assert.match(response.body, /No disponible en este momento/);
      assert.doesNotMatch(response.body, /vacía/);
    } finally {
      h.gate.reconnect();
    }
  });

  it('solo existen las rutas de los enlaces', async () => {
    for (const url of ['/', '/api/v1/system/health', '/api/v1/fs/list?path=/', '/s', '/s/x/../../api']) {
      assert.equal((await visit(url)).statusCode, 404, url);
    }
    assert.match((await visit('/robots.txt')).body, /Disallow: \//);
  });

  it('retirar el último enlace activo apaga la puerta; un enlace retirado deja de funcionar al instante', async () => {
    const listed = (await api('GET', '/shares')).json() as ShareListResponse;
    const active = listed.shares.filter((s) => s.state === 'active');
    assert.ok(active.length > 0);
    for (const s of active) assert.equal((await api('DELETE', `/shares/${s.id}`)).statusCode, 204);
    await gateway.reconcile();
    assert.equal(agent.calls.at(-1), 'off');
    assert.equal(gateway.view.state, 'off');
    const after = (await api('GET', '/shares')).json() as ShareListResponse;
    assert.ok(after.shares.every((s) => s.state !== 'active'));
    const revoked = after.shares[0];
    assert.ok(revoked !== undefined);
    assert.equal((await api('DELETE', `/shares/${revoked.id}`)).statusCode, 204, 'un enlace que ya no funciona se borra de la lista');
    assert.equal((await api('DELETE', `/shares/${revoked.id}`)).statusCode, 404);
  });

  it('puerta: Funnel sin permitir → needs_funnel con el enlace de Tailscale; sin cambios no repite', async () => {
    const calls = agent.calls.length;
    await gateway.reconcile();
    assert.equal(agent.calls.length, calls, 'nada que hacer si ya está como toca');
    agent.next = { ok: false, code: 'FUNNEL_NOT_ALLOWED', enableUrl: 'https://login.tailscale.com/f/funnel?node=abc123' };
    await share({ path: '/Películas', expiresInDays: 1 });
    assert.equal(gateway.view.state, 'needs_funnel');
    assert.equal(gateway.view.enableUrl, 'https://login.tailscale.com/f/funnel?node=abc123');
    await gateway.reconcile(true);
    assert.equal(gateway.view.state, 'on', 'al permitirlo y volver a comprobar, se publica');
  });
});
