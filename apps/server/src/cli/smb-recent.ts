/**
 * pcloud-smb-recent (ADR-0024): sigue en el diario del sistema lo que Samba anota con
 * `full_audit` en la carpeta de red y lo guarda en `smb_recent` para Recientes (Panel).
 *
 *   node apps/server/src/cli/smb-recent.ts [--config /etc/pcloud/config.yaml]
 *
 * Corre como pcloud con el grupo systemd-journal (pcloud-smb-recent.service): así el servidor web
 * no necesita leer el diario. Solo lee el diario y escribe en la base de datos (disco del
 * sistema); nunca toca el disco de datos. Guarda el cursor de journalctl con cada lote para no
 * perder ni repetir líneas al reiniciarse. Si journalctl termina, sale con error y systemd lo
 * vuelve a arrancar.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/config.ts';
import { openDatabase } from '../db/database.ts';
import { parseAuditMessage, SmbRecentStore, type AuditEvent } from '../smb/recent.ts';
import { reportCliError } from './common.ts';

const FLUSH_MS = 2000;
const FLUSH_EVENTS = 500;

/** MESSAGE del diario: texto, o array de bytes si no era UTF-8 válido. */
function messageOf(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((b) => typeof b === 'number')) return Buffer.from(value as number[]).toString('utf8');
  return null;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c', default: '/etc/pcloud/config.yaml' } }, strict: true });
  const config = await loadConfig(values.config);
  const { mountpoint, rootRelative } = config.storage;
  const dataRoot = rootRelative === '.' ? mountpoint : path.posix.join(mountpoint, rootRelative);
  const db = await openDatabase(path.join(config.paths.stateDir, 'database', 'pcloud.sqlite'), {
    snapshotDir: path.join(config.paths.stateDir, 'snapshots-db'),
  });
  const store = new SmbRecentStore(db);

  const cursor = store.cursor();
  const args = ['--follow', '--output=json', '--no-pager', 'SYSLOG_IDENTIFIER=smbd_audit'];
  args.push(cursor === null ? '--lines=0' : `--after-cursor=${cursor}`);
  const journal = spawn('journalctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let pending: Array<{ event: AuditEvent; at: string }> = [];
  let lastCursor: string | null = null;
  let received = 0;
  const flush = (): void => {
    if (pending.length === 0 && lastCursor === null) return;
    store.record(pending, lastCursor);
    pending = [];
    lastCursor = null;
  };
  const timer = setInterval(flush, FLUSH_MS);

  createInterface({ input: journal.stdout }).on('line', (line) => {
    received += 1;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof entry['__CURSOR'] === 'string') lastCursor = entry['__CURSOR'];
    const message = messageOf(entry['MESSAGE']);
    const event = message === null ? null : parseAuditMessage(message, dataRoot);
    if (event !== null) {
      const micros = Number(entry['__REALTIME_TIMESTAMP']);
      const at = (Number.isFinite(micros) ? new Date(micros / 1000) : new Date()).toISOString();
      pending.push({ event, at });
    }
    if (pending.length >= FLUSH_EVENTS) flush();
  });
  createInterface({ input: journal.stderr }).on('line', (line) => console.error(`journalctl: ${line}`));

  const stop = (): void => {
    journal.kill('SIGTERM');
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const code = await new Promise<number>((resolve) => {
    journal.once('error', (error) => {
      console.error(`No se pudo ejecutar journalctl: ${error.message}`);
      resolve(1);
    });
    journal.once('close', (exit, signal) => resolve(signal === 'SIGTERM' ? 0 : (exit ?? 1)));
  });
  clearInterval(timer);
  flush();
  // Un cursor que ya no existe (diario rotado o en memoria tras reiniciar) hace que journalctl
  // falle sin leer nada: se olvida y el siguiente arranque empieza por lo nuevo.
  if (code !== 0 && received === 0 && cursor !== null) {
    console.error('El cursor guardado no es válido: se empieza por las líneas nuevas');
    store.forgetCursor();
  }
  db.close();
  return code === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => process.exit(reportCliError(error)),
);
