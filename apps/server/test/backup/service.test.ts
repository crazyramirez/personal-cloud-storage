import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AgentResult, MountAgent } from '../../src/backup/agent.ts';
import { parseLsblk, type DiskLister, type ExternalDisk } from '../../src/backup/disks.ts';
import { BackupService } from '../../src/backup/service.ts';
import { openDatabase, type Db } from '../../src/db/database.ts';

const UUID = 'ABCD-1234';
const OTHER = 'FFFF-0000';

/** Agente falso: «montar» = el directorio del disco simulado queda accesible en el mountpoint. */
class FakeAgent implements MountAgent {
  mounted: string | null = null;
  calls: string[] = [];
  failMount: AgentResult['code'] | null = null;
  async ready(): Promise<boolean> {
    return true;
  }
  async request(action: 'mount' | 'unmount', uuid: string): Promise<AgentResult> {
    this.calls.push(`${action} ${uuid}`);
    if (action === 'mount') {
      if (this.failMount !== null) return { ok: false, code: this.failMount };
      this.mounted = uuid;
      return { ok: true, code: 'MOUNTED' };
    }
    this.mounted = null;
    return { ok: true, code: 'UNMOUNTED' };
  }
}

class FakeDisks implements DiskLister {
  disks: ExternalDisk[] = [];
  async fingerprint(): Promise<string> {
    return this.disks.map((disk) => disk.uuid).join(',');
  }
  async list(): Promise<ExternalDisk[]> {
    return this.disks;
  }
}

const disk = (uuid: string, fsType = 'exfat'): ExternalDisk => ({
  uuid,
  device: '/dev/sdb1',
  fsType,
  compatible: fsType === 'exfat' || fsType === 'ntfs',
  sizeBytes: 2e12,
  label: 'COPIA',
  model: 'Disco USB',
  mountpoint: null,
});

describe('BackupService', () => {
  let base: string;
  let source: string;
  let mountpoint: string;
  let db: Db;
  let agent: FakeAgent;
  let disks: FakeDisks;
  let service: BackupService;
  let sourceReady: boolean;

  const make = (): BackupService =>
    new BackupService({
      db,
      agent,
      disks,
      mountpoint,
      sourceRoot: source,
      sourceReady: () => sourceReady,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      verifyMount: async () => agent.mounted !== null,
      flush: async () => undefined,
    });

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pcloud-bksvc-'));
    source = path.join(base, 'data');
    mountpoint = path.join(base, 'copia');
    await mkdir(source, { recursive: true });
    await mkdir(mountpoint, { recursive: true });
    db = await openDatabase(':memory:');
    agent = new FakeAgent();
    disks = new FakeDisks();
    sourceReady = true;
    service = make();
  });

  afterEach(async () => {
    service.stop();
    db.close();
    await rm(base, { recursive: true, force: true });
  });

  it('un disco nuevo aparece como no asignado; al asignarlo se marca y se desmonta', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    let status = service.status();
    assert.equal(status.assigned, null);
    assert.deepEqual(status.disks.map((item) => [item.uuid, item.assigned, item.compatible]), [[UUID, false, true]]);

    await service.assign(UUID, 1);
    status = service.status();
    assert.equal(status.assigned?.uuid, UUID);
    assert.equal(status.assignedConnected, true);
    assert.match(await readFile(path.join(mountpoint, '.pcloud-backup', 'backup-id'), 'utf8'), /^pcloud-backup-v1 [0-9a-f-]{36}\n$/);
    assert.ok((await readdir(mountpoint)).includes('Personal Cloud Storage'));
    assert.deepEqual(agent.calls, [`mount ${UUID}`, `unmount ${UUID}`]);
    assert.equal(agent.mounted, null, 'nunca se queda montado');
  });

  it('no deja asignar un disco que no es exFAT ni NTFS', async () => {
    disks.disks = [disk(UUID, 'vfat')];
    await service.poll();
    await assert.rejects(service.assign(UUID, 1), /exFAT o NTFS/);
  });

  it('sincroniza, registra el resultado y desmonta al terminar', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    await mkdir(path.join(source, 'Fotos'));
    await writeFile(path.join(source, 'Fotos', 'a.jpg'), 'a');
    await writeFile(path.join(source, 'b.txt'), 'b');

    await service.startSync(false, 1);
    await service.settled();
    const status = service.status();
    assert.equal(status.phase, 'idle');
    assert.equal(status.lastRun?.result, 'ok');
    assert.deepEqual(status.lastRun?.summary, { newFiles: 2, changedFiles: 0, removedFiles: 0, unchangedFiles: 0, bytesToCopy: 2 });
    assert.ok(status.lastSuccessAt !== null);
    assert.equal(await readFile(path.join(mountpoint, 'Personal Cloud Storage', 'Fotos', 'a.jpg'), 'utf8'), 'a');
    assert.equal((await readdir(path.join(mountpoint, '.pcloud-backup', 'informes'))).length, 1);
    assert.equal(agent.mounted, null);

    // Segunda vez: nada que copiar.
    await service.startSync(false, 1);
    await service.settled();
    assert.deepEqual(service.status().lastRun?.summary.unchangedFiles, 2);
  });

  it('se niega si el disco tiene el mismo UUID pero otra marca (DISK_MISMATCH)', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    await writeFile(path.join(mountpoint, '.pcloud-backup', 'backup-id'), 'pcloud-backup-v1 11111111-2222-4333-8444-555555555555\n');
    await writeFile(path.join(source, 'a.txt'), 'a');
    await service.startSync(false, 1);
    await service.settled();
    const status = service.status();
    assert.equal(status.lastRun?.result, 'failed');
    assert.equal(status.problem, 'DISK_MISMATCH');
    assert.deepEqual(await readdir(path.join(mountpoint, 'Personal Cloud Storage')), [], 'no se escribió nada');
  });

  it('sin la nube disponible no empieza (SOURCE_UNAVAILABLE)', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    sourceReady = false;
    await service.startSync(false, 1);
    await service.settled();
    assert.equal(service.status().problem, 'SOURCE_UNAVAILABLE');
    assert.ok(!agent.calls.slice(2).includes(`mount ${UUID}`), 'ni siquiera se monta');
  });

  it('muchos borrados piden confirmación; sin confirmar no se toca nada', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    const mirror = path.join(mountpoint, 'Personal Cloud Storage');
    for (let i = 0; i < 120; i += 1) await writeFile(path.join(mirror, `viejo-${i}.txt`), 'x');
    await writeFile(path.join(source, 'unico.txt'), 'u');

    await service.startSync(false, 1);
    for (let i = 0; i < 100 && service.status().phase !== 'confirm'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = service.status();
    assert.equal(waiting.phase, 'confirm');
    assert.equal(waiting.pendingPlan?.removedFiles, 120);

    service.cancel();
    await service.settled();
    assert.equal(service.status().lastRun?.result, 'cancelled');
    assert.equal((await readdir(mirror)).length, 120, 'lo cancelado no aparta nada');

    // Confirmando: se aparta todo al archivo (no se borra) y se copia lo nuevo.
    await service.startSync(false, 1);
    for (let i = 0; i < 100 && service.status().phase !== 'confirm'; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    await service.startSync(true, 1);
    await service.settled();
    assert.equal(service.status().lastRun?.result, 'ok');
    assert.deepEqual(await readdir(mirror), ['unico.txt']);
    const archived = await readdir(path.join(mountpoint, '.pcloud-backup', 'archivo'));
    assert.equal((await readdir(path.join(mountpoint, '.pcloud-backup', 'archivo', archived[0] as string))).length, 120);
  });

  it('con autoSync, conectar el disco asignado empieza la copia sola', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    service.setSettings({ autoSync: true });
    await writeFile(path.join(source, 'a.txt'), 'a');
    disks.disks = [];
    await service.poll();
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.settled();
    assert.equal(service.status().lastRun?.result, 'ok');
  });

  it('un disco distinto al asignado se ofrece como nuevo, sin tocarlo', async () => {
    disks.disks = [disk(UUID)];
    await service.poll();
    await service.assign(UUID, 1);
    disks.disks = [disk(OTHER)];
    await service.poll();
    const status = service.status();
    assert.equal(status.assignedConnected, false);
    assert.deepEqual(status.disks.map((item) => [item.uuid, item.assigned]), [[OTHER, false]]);
    assert.equal(agent.calls.length, 2, 'detectar un disco nunca lo monta');
  });

  it('una sincronización cortada por un reinicio queda como fallida', async () => {
    db.prepare("INSERT INTO backup_runs (disk_uuid, started_at, result) VALUES (?, ?, 'running')").run(UUID, '2026-11-14T10:00:00Z');
    await service.start(60_000);
    assert.equal(service.status().lastRun?.error, 'INTERRUPTED');
  });
});

describe('parseLsblk', () => {
  const sample = JSON.stringify({
    blockdevices: [
      { name: '/dev/mmcblk0', pkname: null, type: 'disk', fstype: null, uuid: null, size: 64e9, model: null, mountpoint: null },
      { name: '/dev/mmcblk0p2', pkname: '/dev/mmcblk0', type: 'part', fstype: 'ext4', uuid: 'root-uuid', size: 63e9, mountpoint: '/' },
      { name: '/dev/sda', pkname: null, type: 'disk', fstype: null, uuid: null, size: 5e12, model: 'WD Elements', mountpoint: null },
      { name: '/dev/sda1', pkname: '/dev/sda', type: 'part', fstype: 'exfat', uuid: 'EFFF-BB4A', size: 5e12, label: 'PCLOUD', mountpoint: '/srv/pcloud' },
      { name: '/dev/sdb', pkname: null, type: 'disk', fstype: null, uuid: null, size: 2e12, model: 'Seagate  ', mountpoint: null },
      { name: '/dev/sdb1', pkname: '/dev/sdb', type: 'part', fstype: 'exfat', uuid: 'ABCD-1234', size: 2e12, label: 'COPIA', mountpoint: null },
      { name: '/dev/sdc1', pkname: '/dev/sdc', type: 'part', fstype: 'vfat', uuid: '1111-2222', size: 32e9, label: 'USB', mountpoint: null },
      { name: '/dev/sdd1', pkname: '/dev/sdd', type: 'part', fstype: 'ntfs', uuid: '0123456789ABCDEF', size: 1e12, mountpoint: '/media/otro' },
      { name: '/dev/zram0', pkname: null, type: 'disk', fstype: 'swap', uuid: 'z', size: 1e9, mountpoint: '[SWAP]' },
    ],
  });

  it('lista solo discos externos: sin el del sistema, el de datos, swap ni montados en otro sitio', () => {
    const disks = parseLsblk(sample, 'efff-bb4a', '/srv/pcloud-backup');
    assert.deepEqual(
      disks.map((item) => [item.uuid, item.fsType, item.compatible, item.model, item.label]),
      [
        ['ABCD-1234', 'exfat', true, 'Seagate', 'COPIA'],
        ['1111-2222', 'vfat', false, null, 'USB'],
      ],
    );
  });
});
