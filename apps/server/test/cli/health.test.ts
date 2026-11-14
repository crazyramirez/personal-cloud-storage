import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/http/app.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const CLI = fileURLToPath(new URL('../../src/cli/health.ts', import.meta.url));
const RELEASE = 'pcloud-20260101T000000Z';

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('cli/health: comprobación de salud que usa el despliegue', () => {
  let harness: Harness;
  let app: FastifyInstance;
  let config: string;
  let deadConfig: string;

  before(async () => {
    harness = await createHarness();
    app = await buildApp({ config: harness.config, db: harness.db, guardian: harness.gate, uploads: harness.uploads(), logger: false, release: RELEASE });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    config = path.join(harness.root, 'health-config.yaml');
    await writeFile(config, `server:\n  host: 127.0.0.1\n  port: ${port}\n`);
    // Un puerto donde no escucha nadie: se abre y se cierra un servidor para obtener uno libre.
    deadConfig = path.join(harness.root, 'health-dead.yaml');
    const probe = await buildApp({ config: harness.config, db: harness.db, guardian: harness.gate, uploads: harness.uploads(), logger: false });
    await probe.listen({ host: '127.0.0.1', port: 0 });
    const deadPort = (probe.server.address() as AddressInfo).port;
    await probe.close();
    await writeFile(deadConfig, `server:\n  host: 127.0.0.1\n  port: ${deadPort}\n`);
  });

  after(async () => {
    await app.close();
    await harness.dispose();
  });

  it('sale con 0 y publica la release cuando el servidor responde', async () => {
    const result = await run(['--config', config, '--expect-release', RELEASE]);
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout) as { status: string; release: string; volumeState: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.release, RELEASE);
  });

  it('sigue sano sin disco: el estado del volumen no cuenta como fallo del servicio', async () => {
    harness.gate.disconnect();
    try {
      const result = await run(['--config', config]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal((JSON.parse(result.stdout) as { volumeState: string }).volumeState, 'UNAVAILABLE');
    } finally {
      harness.gate.reconnect();
    }
  });

  it('sale con 1 si responde otra release (el servicio no se reinició con la nueva)', async () => {
    const result = await run(['--config', config, '--expect-release', 'pcloud-20270101T000000Z']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Se esperaba la release/);
  });

  it('sale con 1 si no escucha nadie y con 64 si la configuración o los argumentos son inválidos', async () => {
    const dead = await run(['--config', deadConfig, '--timeout-ms', '1500']);
    assert.equal(dead.code, 1);
    assert.match(dead.stderr, /sin respuesta/);
    assert.equal((await run(['--config', path.join(harness.root, 'no-existe.yaml')])).code !== 0, true);
    assert.equal((await run(['--config', config, '--timeout-ms', 'abc'])).code, 64);
  });
});
