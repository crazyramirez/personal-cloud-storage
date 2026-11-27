/**
 * Arranque del servidor Personal Cloud Storage (un solo proceso gestionado por systemd, spec §4).
 *
 *   node apps/server/src/main.ts --config /etc/pcloud/config.yaml
 *
 * Arranca aunque el HDD no esté: la API responde y las rutas de ficheros devuelven 503
 * STORAGE_UNAVAILABLE hasta que el StorageGuardian vea el volumen READY (spec §3.4.7).
 */

import { access, readFile, unlink } from 'node:fs/promises';
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
import { ResourceMonitor } from './system/resources.ts';
import { FilePowerAgent } from './system/power.ts';
import { FileVolumeRepairAgent } from './system/volume-repair.ts';
import { PairingService } from './system/pairing.ts';
import { FileGatewayAgent, GUEST_SOCKET, ShareGateway, type GatewayLogger } from './share/gateway.ts';
import { buildGuestApp } from './share/guest-app.ts';
import { ShareStore } from './share/store.ts';
import { MediaService } from './media/service.ts';
import { FsOperations } from './storage/operations.ts';
import { relocatePaths } from './storage/relocate.ts';
import { SearchIndex } from './storage/search-index.ts';
import { SmbRecentStore } from './smb/recent.ts';
import { SerialQueue } from './storage/serial.ts';
import { UploadManager } from './storage/uploads.ts';

const MiB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;

/**
 * Release desplegada (release.json en la raíz del paquete) y versión de la app. En desarrollo no
 * hay release.json: la versión sale de package.json.
 */
async function releaseInfo(): Promise<{ name: string | null; version: string | null }> {
  const readJson = async (file: string): Promise<Record<string, unknown> | null> => {
    try {
      const raw: unknown = JSON.parse(await readFile(path.resolve(import.meta.dirname, '../../..', file), 'utf8'));
      return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const release = await readJson('release.json');
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const version = text(release?.['version']) ?? text((await readJson('package.json'))?.['version']);
  return { name: text(release?.['name']), version };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string', short: 'c', default: '/etc/pcloud/config.yaml' } }, strict: true });
  const config = await loadConfig(values.config);

  const db = await openDatabase(path.join(config.paths.stateDir, 'database', 'pcloud.sqlite'), {
    snapshotDir: path.join(config.paths.stateDir, 'snapshots-db'),
  });
  const guardian = createGuardian(config);
  // Índice de nombres para la búsqueda (ADR-0029, ADR-0030): proceso aparte de prioridad baja;
  // caché en el HDD; al día con los cambios de la web y el diario de la carpeta de red.
  let indexLog: GatewayLogger = console as unknown as GatewayLogger;
  const smbRecent = new SmbRecentStore(db);
  const searchIndex = new SearchIndex({
    gate: guardian,
    changes: (since) => {
      const rows = smbRecent.since(since);
      return { paths: rows.map((row) => row.path), last: rows.at(-1)?.at ?? null };
    },
    log: { info: (o, m) => indexLog.info(o, m), warn: (o, m) => indexLog.warn(o, m) },
  });
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
    relocated: (from, to) => {
      searchIndex.relocated(from, to);
      relocatePaths(db, from, to);
    },
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
  const { name: release, version } = await releaseInfo();
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
  const resources = new ResourceMonitor();
  resources.start();
  // Enlaces para invitados (ADR-0018): Funnel solo se publica mientras haya alguno activo.
  const shareStore = new ShareStore(db);
  let gatewayLog: GatewayLogger = console as unknown as GatewayLogger;
  const gateway = new ShareGateway({
    agent: new FileGatewayAgent(),
    activeCount: () => shareStore.countActive(new Date()),
    log: { info: (o, m) => gatewayLog.info(o, m), warn: (o, m) => gatewayLog.warn(o, m) },
  });
  const volumeRepair = new FileVolumeRepairAgent();
  const app = await buildApp({ config, db, guardian, uploads, operations, media, release, backup, resources, shares: { store: shareStore, gateway }, power: new FilePowerAgent(), volumeRepair, pairing: new PairingService(), version, searchIndex });
  backupLog = app.log;
  gatewayLog = app.log;
  indexLog = app.log;
  const guest = await buildGuestApp({ db, store: shareStore, guardian, media, logLevel: config.server.logLevel, onShareChanged: () => void gateway.reconcile() });
  app.log.info({ ffmpeg: tools.ffmpeg !== null, office: tools.soffice !== null, hwEncoder: tools.hwEncoder }, 'visores');

  // Reconciliar el diario de subidas cada vez que el volumen pasa a READY (spec §3.4.9): primero
  // se resuelve lo que quedó a medias; nunca se purga nada al recuperar el disco.
  guardian.onChange((snapshot) => {
    app.log.info({ state: snapshot.state, generation: snapshot.generation, issues: snapshot.issues.map((i) => i.code) }, 'estado del volumen');
    if (snapshot.state === 'READY' || snapshot.state === 'READ_ONLY') void searchIndex.ensureLoaded();
    // Solo lectura por un error del sistema de archivos (exFAT errors=remount-ro, típico tras un
    // corte de luz): el agente root desmonta, repara y vuelve a montar (ADR-0032). Él decide si
    // hace falta y limita los intentos; aquí solo se avisa en cada entrada en READ_ONLY.
    if (snapshot.state === 'READ_ONLY' && snapshot.issues[0]?.code === 'MOUNT_READ_ONLY') {
      volumeRepair.request().then(
        (sent) => app.log.warn({ sent }, sent ? 'disco en solo lectura: se pide la reparación automática' : 'disco en solo lectura y sin reparación automática instalada'),
        (error: unknown) => app.log.error({ err: error }, 'no se pudo pedir la reparación automática del disco'),
      );
    }
    if (snapshot.state === 'READY') {
      uploads.recover().catch((error: unknown) => app.log.error({ err: error }, 'fallo al reconciliar subidas'));
      operations.recover().catch((error: unknown) => app.log.error({ err: error }, 'fallo al reconciliar operaciones'));
    }
  });
  guardian.start(config.storage.healthCheckIntervalSeconds * 1000);
  backup.start().catch((error: unknown) => app.log.error({ err: error }, 'no se pudo iniciar la copia de seguridad'));
  gateway.start();
  searchIndex.start();

  const housekeeping = setInterval(() => {
    purgeExpiredSessions(db, new Date());
    shareStore.purge(new Date());
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
    Promise.all([app.close(), guest.close()])
      .catch((error: unknown) => app.log.error({ err: error }, 'error al cerrar'))
      .finally(() => {
        clearInterval(housekeeping);
        backup.stop();
        gateway.stop();
        searchIndex.stop();
        resources.stop();
        guardian.stop();
        db.close();
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await app.listen({ host: config.server.host, port: config.server.port });
  // La puerta de invitados escucha SOLO en un socket Unix (pcloud 0600 en un directorio 0700): a
  // Internet llega únicamente por Funnel, y solo mientras haya enlaces activos.
  if (await access(path.dirname(GUEST_SOCKET)).then(() => true, () => false)) {
    await unlink(GUEST_SOCKET).catch(() => undefined); // socket de un arranque anterior
    await guest.listen({ path: GUEST_SOCKET });
    app.log.info('puerta de invitados lista (socket local)');
  } else {
    app.log.warn('puerta de invitados sin instalar (pcloud-install-share.sh): los enlaces no serán accesibles desde Internet');
  }
  app.log.info({ release, version, node: process.version, volume: guardian.current.state }, 'servidor en marcha');
}

main().catch((error: unknown) => {
  process.exitCode = reportCliError(error);
});
