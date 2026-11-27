import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { StorageResponse, VolumeRepairStatus } from '@pcloud/contracts';
import { createSession } from '../../src/auth/sessions.ts';
import { buildApp } from '../../src/http/app.ts';
import { FileVolumeRepairAgent, parseRepairStatus, type VolumeRepairAgent } from '../../src/system/volume-repair.ts';
import { createHarness, insertUser, type Harness } from '../support/harness.ts';

const NOW = new Date('2026-11-27T01:00:00Z');

describe('reparación automática del disco (ADR-0032)', () => {
  it('interpreta el estado del agente y descarta lo que no encaja', () => {
    const running = '{"phase":"running","trigger":"dirty","result":null,"startedAt":"2026-11-27T00:58:00Z","finishedAt":null}\n';
    const empty = { step: null, stepStartedAt: null, estimateSeconds: null, fixed: null };
    assert.deepEqual(parseRepairStatus(running, NOW), {
      phase: 'running',
      trigger: 'dirty',
      result: null,
      startedAt: '2026-11-27T00:58:00Z',
      finishedAt: null,
      ...empty,
    }, 'sin detalle de progreso (agente anterior): campos a null');
    const detailed = '{"phase":"running","trigger":"readonly","result":null,"startedAt":"2026-11-27T00:58:00Z","finishedAt":null,"step":"verify","stepStartedAt":"2026-11-27T00:59:00Z","estimateSeconds":287,"fixed":1}';
    assert.deepEqual(parseRepairStatus(detailed, NOW), {
      phase: 'running',
      trigger: 'readonly',
      result: null,
      startedAt: '2026-11-27T00:58:00Z',
      finishedAt: null,
      step: 'verify',
      stepStartedAt: '2026-11-27T00:59:00Z',
      estimateSeconds: 287,
      fixed: 1,
    });
    const odd = '{"phase":"running","trigger":"dirty","result":null,"startedAt":"2026-11-27T00:58:00Z","finishedAt":null,"step":"format","stepStartedAt":"ya","estimateSeconds":-3,"fixed":"1"}';
    assert.deepEqual(parseRepairStatus(odd, NOW), { phase: 'running', trigger: 'dirty', result: null, startedAt: '2026-11-27T00:58:00Z', finishedAt: null, ...empty }, 'el detalle raro se ignora');
    const done = '{"phase":"done","trigger":"readonly","result":"repaired","startedAt":"2026-11-27T00:50:00Z","finishedAt":"2026-11-27T00:59:00Z"}';
    assert.equal(parseRepairStatus(done, NOW)?.result, 'repaired');
    for (const bad of ['', 'no es json', 'null', '{"phase":"formatting","trigger":"dirty","result":null,"startedAt":"2026-11-27T00:58:00Z","finishedAt":null}', '{"phase":"done","trigger":"dirty","result":"rm -rf","startedAt":"2026-11-27T00:58:00Z","finishedAt":null}', '{"phase":"done","trigger":"dirty","result":null,"startedAt":"ayer","finishedAt":null}']) {
      assert.equal(parseRepairStatus(bad, NOW), null, bad);
    }
  });

  it('una reparación que lleva horas «en marcha» se da por interrumpida', () => {
    const stuck = '{"phase":"running","trigger":"dirty","result":null,"startedAt":"2026-11-26T12:00:00Z","finishedAt":null}';
    assert.deepEqual(parseRepairStatus(stuck, NOW), { phase: 'failed', trigger: 'dirty', result: 'io_error', startedAt: '2026-11-26T12:00:00Z', finishedAt: null, step: null, stepStartedAt: null, estimateSeconds: null, fixed: null });
  });

  describe('agente de ficheros', () => {
    let dir = '';
    before(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'pcloud-volume-repair-'));
    });
    after(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('sin buzón no avisa; con buzón deja un aviso vacío', async () => {
      const inbox = path.join(dir, 'inbox');
      const agent = new FileVolumeRepairAgent(inbox, path.join(dir, 'status.json'), () => NOW);
      assert.equal(await agent.request(), false);
      await mkdir(inbox);
      assert.equal(await agent.request(), true);
      const files = await readdir(inbox);
      assert.equal(files.length, 1);
      assert.match(files[0]!, /^[0-9a-f]{20}\.req$/);
    });

    it('lee el estado de /run y, sin fichero, no hay reparación', async () => {
      const status = path.join(dir, 'status.json');
      const agent = new FileVolumeRepairAgent(path.join(dir, 'inbox'), status, () => NOW);
      assert.equal(await agent.status(), null);
      await writeFile(status, '{"phase":"pending","trigger":"readonly","result":null,"startedAt":"2026-11-27T00:59:30Z","finishedAt":null}');
      assert.equal((await agent.status())?.phase, 'pending');
    });
  });

  describe('API', () => {
    let h: Harness;
    let app: FastifyInstance;
    let cookie = '';
    let current: VolumeRepairStatus | null = null;
    const repair: VolumeRepairAgent = { request: async () => true, status: async () => current };

    before(async () => {
      h = await createHarness();
      app = await buildApp({ config: h.config, db: h.db, guardian: h.gate, uploads: h.uploads(), logger: false, volumeRepair: repair });
      cookie = `pcloud_session=${createSession(h.db, insertUser(h.db, 'ana', 'owner'), {}, new Date())}`;
    });
    after(async () => {
      await app.close();
      await h.dispose();
    });

    it('/system/storage publica la reparación en curso', async () => {
      const get = async () => (await app.inject({ method: 'GET', url: '/api/v1/system/storage', headers: { cookie } })).json() as StorageResponse;
      assert.equal((await get()).repair, null);
      current = { phase: 'running', trigger: 'dirty', result: null, startedAt: '2026-11-27T00:58:00Z', finishedAt: null, step: 'scan', stepStartedAt: '2026-11-27T00:58:00Z', estimateSeconds: 287, fixed: null };
      h.gate.disconnect();
      try {
        const storage = await get();
        assert.equal(storage.state, 'UNAVAILABLE');
        assert.deepEqual(storage.repair, current);
      } finally {
        h.gate.reconnect();
      }
    });
  });
});
