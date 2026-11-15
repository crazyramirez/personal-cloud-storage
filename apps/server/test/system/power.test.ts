import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { createSession } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import type { PowerAction, PowerAgent } from '../../src/system/power.ts';
import { createHarness, insertUser, type Harness } from '../support/harness.ts';

const CSRF = { 'x-pcloud-request': '1' };

class FakePower implements PowerAgent {
  installed = true;
  calls: PowerAction[] = [];

  async ready(): Promise<boolean> {
    return this.installed;
  }

  async request(action: PowerAction): Promise<{ ok: boolean; code: string }> {
    if (!this.installed) return { ok: false, code: 'AGENT_UNAVAILABLE' };
    this.calls.push(action);
    return { ok: true, code: 'SCHEDULED' };
  }
}

describe('reiniciar y apagar desde Ajustes (ADR-0020)', () => {
  let h: Harness;
  let app: FastifyInstance;
  const power = new FakePower();
  let owner = '';
  let member = '';

  before(async () => {
    h = await createHarness();
    app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false, power });
    owner = `pcloud_session=${createSession(h.db, insertUser(h.db, 'ana', 'owner'), {}, new Date())}`;
    member = `pcloud_session=${createSession(h.db, insertUser(h.db, 'luis', 'user'), {}, new Date())}`;
  });
  after(async () => {
    await app.close();
    await h.dispose();
  });

  const post = (body: object, cookie = owner, headers: Record<string, string> = CSRF) =>
    app.inject({ method: 'POST', url: '/api/v1/system/power', headers: { ...headers, cookie }, payload: body });

  it('solo el propietario, con la cabecera anti-CSRF y una acción válida', async () => {
    assert.equal((await post({ action: 'reboot' }, member)).statusCode, 403);
    assert.equal((await post({ action: 'reboot' }, owner, {})).statusCode, 403, 'sin cabecera anti-CSRF');
    assert.equal((await post({ action: 'format' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/system/power', headers: CSRF, payload: { action: 'reboot' } })).statusCode, 401);
    assert.deepEqual(power.calls, []);
  });

  it('programa la orden y la deja en la auditoría', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/system/power', headers: { cookie: owner } });
    assert.deepEqual(status.json(), { available: true });
    assert.equal((await post({ action: 'reboot' })).statusCode, 202);
    assert.equal((await post({ action: 'poweroff' })).statusCode, 202);
    assert.deepEqual(power.calls, ['reboot', 'poweroff']);
    const actions = h.db.prepare("SELECT action, result FROM audit_log WHERE action LIKE 'system.%' ORDER BY id").all();
    assert.deepEqual(actions.map((row) => `${String(row['action'])}:${String(row['result'])}`), ['system.reboot:ok', 'system.poweroff:ok']);
  });

  it('sin el agente instalado lo dice claramente', async () => {
    power.installed = false;
    const response = await post({ action: 'reboot' });
    assert.equal(response.statusCode, 500);
    assert.match(response.body, /no está instalado/);
    power.installed = true;
  });
});
