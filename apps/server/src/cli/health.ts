/**
 * Comprueba que el servidor responde en el host y puerto de la configuración.
 *
 *   node apps/server/src/cli/health.ts [--config /etc/pcloud/config.yaml]
 *        [--expect-release NOMBRE] [--timeout-ms 3000]
 *
 * Salida 0: responde `ok`. El estado del volumen NO influye: sin disco el servicio debe seguir
 * sano (spec §3.4.7). Salida 1: no responde, responde otra cosa o ejecuta otra release.
 * Solo hace una petición GET a loopback; no modifica nada. La usa pcloud-deploy-release.sh para
 * decidir si una release recién activada se queda o se revierte.
 */

import { parseArgs } from 'node:util';
import type { HealthResponse } from '@pcloud/contracts';
import { loadConfig } from '../config/config.ts';
import { EXIT_USAGE, reportCliError } from './common.ts';

/** Dirección a la que conectar para un host de escucha (los comodines no son destinos válidos). */
function connectHost(host: string): string {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '[::1]';
  return host.includes(':') ? `[${host}]` : host;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c', default: '/etc/pcloud/config.yaml' },
      'expect-release': { type: 'string' },
      'timeout-ms': { type: 'string', default: '3000' },
    },
    strict: true,
  });
  const timeout = Number(values['timeout-ms']);
  if (!Number.isInteger(timeout) || timeout < 100) {
    console.error('--timeout-ms debe ser un entero >= 100');
    return EXIT_USAGE;
  }
  const config = await loadConfig(values.config);
  const url = `http://${connectHost(config.server.host)}:${config.server.port}/api/v1/system/health`;

  let body: Partial<HealthResponse> | null;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
    if (!response.ok) {
      console.error(`${url}: HTTP ${response.status}`);
      return 1;
    }
    body = (await response.json()) as Partial<HealthResponse> | null;
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : error instanceof Error ? error.message : String(error);
    console.error(`${url}: sin respuesta (${cause})`);
    return 1;
  }
  if (body?.status !== 'ok') {
    console.error(`${url}: respuesta inesperada`);
    return 1;
  }
  const expected = values['expect-release'];
  if (expected !== undefined && body.release !== expected) {
    console.error(`Se esperaba la release ${expected} y responde ${body.release ?? '(sin nombre)'}`);
    return 1;
  }
  console.log(JSON.stringify(body));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.exitCode = reportCliError(error);
  },
);
