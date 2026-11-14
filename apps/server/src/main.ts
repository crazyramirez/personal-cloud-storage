/**
 * Arranque del servidor Personal Cloud Storage (un solo proceso gestionado por systemd, spec §4).
 *
 *   node apps/server/src/main.ts --config /etc/pcloud/config.yaml
 *
 * Arranca aunque el HDD no esté: la API responde y las rutas de ficheros devuelven 503
 * STORAGE_UNAVAILABLE hasta que el StorageGuardian vea el volumen READY (spec §3.4.7).
 */

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { issueSetupToken, ownerExists, purgeExpiredSessions } from './auth/sessions.ts';
import { createGuardian, reportCliError } from './cli/common.ts';
import { loadConfig } from './config/config.ts';
import { openDatabase } from './db/database.ts';
import { FileMountAgent } from './backup/agent.ts';
import { LinuxDiskLister } from './backup/disks.ts';
import { BackupService, type BackupLogger } from './backup/service.ts';
import { buildApp } from './http/app.ts';
import { MediaService } from './media/service.ts';
import { FsOperations } from './storage/operations.ts';
import { SerialQueue } from './storage/serial.ts';
import { UploadManager } from './storage/uploads.ts';

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

/** Nombre de la release desplegada (release.json en la raíz del paquete); null en desarrollo. */
async function releaseName(): Promise<string | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../../release.json'), 'utf8'));
    const name = (raw as { name?: unknown } | null)?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c', default: '/etc/pcloud/config.yaml' } }, strict: true });
  const config = await loadConfig(values.config);

  const db = await openDatabase(path.join(config.paths.stateDir, 'database', 'pcloud.sqlite'), {
    snapshotDir: path.join(config.paths.stateDir, 'snapshots-db'),
  });
  const guardian = createGuardian(config);
  // Una sola cola para todo lo que elige nombres y hace rename: subidas y explorador.
  const serial = new SerialQueue();
  const operations = new FsOperations({
    gate: guardian,
    serial,
    minFreePercent: config.storage.minFreePercent,
    minFreeBytes: config.storage.minFreeBytes,
    trashRetentionDays: config.trash.enabled ? config.trash.retentionDays : null,
    // systemd-timesyncd crea este fichero cuando ha sincronizado la hora con la red.
    clockTrusted: () => access('/run/systemd/timesync/synchronized').then(() => true, () => false),
  });
  const media = new MediaService(guardian, undefined, { minFreePercent: config.storage.minFreePercent, minFreeBytes: config.storage.minFreeBytes });
  const tools = await media.init();
  const uploads = new UploadManager({
    serial,
    db,
    gate: guardian,
    chunkSize: config.transfers.chunkSizeMib * MiB,
    maxChunkSize: Math.max(config.transfers.chunkSizeMib, 16) * MiB,
    checkpointBytes: 64 * MiB,
    ttlMs: config.transfers.stagingTtlHours * HOUR,
    minFreePercent: config.storage.minFreePercent,
    minFreeBytes: config.storage.minFreeBytes,
  });
  const release = await releaseName();
  const BACKUP_MOUNTPOINT = '/srv/pcloud-backup';
  let backupLog: BackupLogger = console as unknown as BackupLogger;
  const backup = new BackupService({
    db,
    agent: new FileMountAgent(),
    disks: new LinuxDiskLister(() => config.storage.expectedFsUuid, BACKUP_MOUNTPOINT),
    mountpoint: BACKUP_MOUNTPOINT,
    sourceRoot: path.resolve(config.storage.mountpoint, config.storage.rootRelative),
    sourceReady: () => guardian.current.state === 'READY' || guardian.current.state === 'READ_ONLY',
    log: { info: (o, m) => backupLog.info(o, m), warn: (o, m) => backupLog.warn(o, m), error: (o, m) => backupLog.error(o, m) },
  });
  const app = await buildApp({ config, db, guardian, uploads, operations, media, release, backup });
  backupLog = app.log;
  app.log.info({ ffmpeg: tools.ffmpeg !== null, office: tools.soffice !== null, hwEncoder: tools.hwEncoder }, 'visores');

  // Reconciliar el diario de subidas cada vez que el volumen pasa a READY (spec §3.4.9): primero
  // se resuelve lo que quedó a medias; nunca se purga nada al recuperar el disco.
  guardian.onChange((snapshot) => {
    app.log.info({ state: snapshot.state, generation: snapshot.generation, issues: snapshot.issues.map((i) => i.code) }, 'estado del volumen');
    if (snapshot.state === 'READY') {
      uploads.recover().catch((error: unknown) => app.log.error({ err: error }, 'fallo al reconciliar subidas'));
      operations.recover().catch((error: unknown) => app.log.error({ err: error }, 'fallo al reconciliar operaciones'));
    }
  });
  guardian.start(config.storage.healthCheckIntervalSeconds * 1000);
  backup.start().catch((error: unknown) => app.log.error({ err: error }, 'no se pudo iniciar la copia de seguridad'));

  const housekeeping = setInterval(() => {
    purgeExpiredSessions(db, new Date());
    if (guardian.current.state === 'READY') {
      uploads.cleanupExpired().catch((error: unknown) => app.log.warn({ err: error }, 'no se pudieron limpiar subidas caducadas'));
      operations.purgeExpired().catch((error: unknown) => app.log.warn({ err: error }, 'no se pudo vaciar la papelera caducada'));
      media.prune().catch((error: unknown) => app.log.warn({ err: error }, 'no se pudo podar la caché de vistas previas'));
    }
  }, HOUR);
  housekeeping.unref();

  if (!ownerExists(db)) {
    const token = issueSetupToken(db, new Date());
    app.log.warn(`CONFIGURACIÓN INICIAL PENDIENTE. Código de un solo uso (válido 24 h): ${token}`);
  }

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal}: cerrando`);
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    app
      .close()
      .catch((error: unknown) => app.log.error({ err: error }, 'error al cerrar'))
      .finally(() => {
        clearInterval(housekeeping);
        backup.stop();
        guardian.stop();
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.server.host, port: config.server.port });
  app.log.info({ release, node: process.version, volume: guardian.current.state }, 'servidor en marcha');
}

main().catch((error: unknown) => {
  process.exitCode = reportCliError(error);
});
