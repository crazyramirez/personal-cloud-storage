/**
 * volume-status — muestra el veredicto del StorageGuardian sobre el volumen real.
 *
 * SOLO LECTURA: lee /proc/self/mountinfo, hace stat/lstat/realpath, lee el marcador y
 * consulta access(W_OK). No crea, mueve ni borra nada.
 *
 * Uso (en la Pi; el comando instalado `pcloud-volume-status` ya pasa --config y se ejecuta como pcloud):
 *   node apps/server/src/cli/volume-status.ts --config /etc/pcloud/config.yaml
 *   node apps/server/src/cli/volume-status.ts --uuid 1A2B-3C4D --fs-type exfat
 *   node apps/server/src/cli/volume-status.ts --uuid 1A2B-3C4D --watch 1     # prueba de desconexión
 *
 * Código de salida (modo único): 0 READY, 1 READ_ONLY, 2 cualquier otro estado, 64 uso incorrecto.
 */

import { parseArgs } from 'node:util';
import type { VolumeSnapshot } from '../storage/storage-guardian.ts';
import { toPublicStatus } from '../storage/storage-guardian.ts';
import { createGuardian, EXIT_USAGE, loadConfigWithOverrides, reportCliError } from './common.ts';

const HELP = `Uso: node volume-status.ts [--config FICHERO] [--uuid UUID] [--fs-type exfat|ntfs3|ntfs-3g]
                        [--mountpoint RUTA] [--marker ID|none] [--root RELATIVA] [--watch SEGUNDOS] [--json]

Muestra el estado del volumen según el StorageGuardian. Solo lectura.
Las opciones de línea de comandos sustituyen a las del fichero de configuración.`;

function parseCli() {
  try {
    return parseArgs({
      options: {
        config: { type: 'string', short: 'c' },
        uuid: { type: 'string' },
        'fs-type': { type: 'string' },
        mountpoint: { type: 'string' },
        marker: { type: 'string' },
        root: { type: 'string' },
        watch: { type: 'string', short: 'w' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(HELP);
    process.exit(EXIT_USAGE);
  }
}

function render(snapshot: VolumeSnapshot, json: boolean): string {
  if (json) return JSON.stringify(toPublicStatus(snapshot));
  const mount = snapshot.mount;
  const where = mount === null ? 'sin montaje' : `${mount.source} → ${mount.mountPoint} (${mount.fsType}${mount.readOnly ? ', ro' : ''})`;
  const lines = [`[${snapshot.checkedAt}] ${snapshot.state.padEnd(12)} gen=${snapshot.generation}  ${where}`];
  for (const item of snapshot.issues) {
    const detail = item.detail === undefined ? '' : `  ${JSON.stringify(item.detail)}`;
    lines.push(`    ${item.code}: ${item.message}${detail}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseCli();
  if (args.help) {
    console.log(HELP);
    return;
  }
  if (process.platform !== 'linux') {
    console.error('Aviso: este comando está pensado para Linux; en otro SO el volumen siempre aparecerá como no disponible.');
  }

  let guardian;
  try {
    const config = await loadConfigWithOverrides({
      config: args.config,
      uuid: args.uuid,
      fsType: args['fs-type'],
      mountpoint: args.mountpoint,
      marker: args.marker,
      root: args.root,
    });
    guardian = createGuardian(config);
  } catch (error) {
    process.exit(reportCliError(error));
  }

  if (args.watch === undefined) {
    const snapshot = await guardian.check();
    console.log(render(snapshot, args.json));
    process.exitCode = snapshot.state === 'READY' ? 0 : snapshot.state === 'READ_ONLY' ? 1 : 2;
    return;
  }

  const seconds = Number(args.watch);
  if (!Number.isFinite(seconds) || seconds < 0.2) {
    console.error('--watch requiere un número de segundos >= 0.2');
    process.exit(EXIT_USAGE);
  }
  console.error(`Vigilando cada ${seconds}s; solo se imprimen los cambios. Ctrl+C para salir.`);
  const activeGuardian = guardian;
  activeGuardian.onChange((snapshot) => console.log(render(snapshot, args.json)));
  const tick = (): void => {
    activeGuardian.check().catch((error: unknown) => console.error(`Error comprobando el volumen: ${String(error)}`));
  };
  tick();
  const timer = setInterval(tick, seconds * 1000);
  const stop = (): void => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

await main();
