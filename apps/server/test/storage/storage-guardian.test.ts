import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VolumeIssueCode, VolumeState } from '@pcloud/contracts';
import { StorageUnavailableError, type StorageGuardianOptions } from '../../src/storage/storage-guardian.ts';
import {
  createGuardian,
  FS_UUID,
  HDD,
  hddMountLine,
  healthyWorld,
  MARKER,
  MOUNTPOINT,
  OTHER_DISK,
  OTHER_MARKER,
  SD_ROOT,
  unmountCleanly,
  unplugWithoutUnmount,
  type World,
} from '../support/scenarios.ts';

async function assertRejectsStorage(promise: Promise<unknown>, state?: VolumeState): Promise<StorageUnavailableError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof StorageUnavailableError, `se esperaba StorageUnavailableError, llegó ${String(error)}`);
    assert.equal(error.code, 'STORAGE_UNAVAILABLE');
    assert.equal(error.httpStatus, 503);
    if (state !== undefined) assert.equal(error.volumeState, state);
    return error;
  }
  assert.fail('La operación debía ser rechazada por el StorageGuardian');
}

describe('StorageGuardian — volumen sano', () => {
  for (const fsType of ['exfat', 'ntfs3', 'ntfs-3g'] as const) {
    it(`${fsType}: READY y concede lease de escritura`, async () => {
      const world = healthyWorld(fsType);
      const guardian = createGuardian(world);
      assert.equal(guardian.current.state, 'INITIALIZING');
      assert.equal(guardian.current.generation, 0);

      const snapshot = await guardian.check();
      assert.equal(snapshot.state, 'READY');
      assert.deepEqual(snapshot.issues, []);
      assert.equal(snapshot.generation, 1);
      assert.equal(snapshot.mount?.source, '/dev/sda1');

      const lease = await guardian.assertWritableVolume();
      assert.equal(lease.kind, 'write');
      assert.equal(lease.dataRoot, '/srv/pcloud/data');
      assert.equal(lease.internalDir, '/srv/pcloud/.pcloud');
      assert.ok(Object.isFrozen(lease));
      await guardian.revalidate(lease);
    });
  }

  it('namespace systemd (ReadWritePaths=) con el HDD montado encima del bind: READY', async () => {
    const world = healthyWorld('exfat');
    world.setMounts(
      { id: 41, parent: 22, dev: SD_ROOT, root: '/srv/pcloud', mountPoint: MOUNTPOINT, fsType: 'ext4', source: '/dev/mmcblk0p2' },
      hddMountLine('exfat', { id: 50, parent: 41 }),
    );
    assert.equal((await createGuardian(world).check()).state, 'READY');
  });

  it('raíz administrada "." (volumen completo): READY', async () => {
    const world = healthyWorld('exfat');
    const snapshot = await createGuardian(world, { dataRootRelative: '.' }).check();
    assert.equal(snapshot.state, 'READY');
  });

  it('nunca invoca operaciones distintas de las de solo lectura', async () => {
    const world = healthyWorld('exfat');
    await createGuardian(world).check();
    const ops = new Set(world.probe.calls.map((call) => call.op));
    for (const op of ops) {
      assert.ok(['readMountInfo', 'lstat', 'stat', 'realpath', 'readTextFile', 'checkWritable'].includes(op));
    }
  });
});

interface FaultCase {
  readonly name: string;
  readonly state: VolumeState;
  readonly code: VolumeIssueCode;
  readonly fsType?: 'exfat' | 'ntfs3' | 'ntfs-3g';
  readonly options?: Partial<StorageGuardianOptions>;
  readonly arrange?: (world: World) => void;
}

/**
 * Matriz de fallos: cada caso rompe UNA condición de un mundo sano.
 * Invariante: ninguno puede producir READY ni conceder un lease de escritura.
 */
const FAULTS: readonly FaultCase[] = [
  { name: 'UUID sin configurar', state: 'NEEDS_CHECK', code: 'NOT_CONFIGURED', options: { expectedFsUuid: null } },
  {
    name: 'HDD no montado: solo queda el directorio vacío de la microSD',
    state: 'UNAVAILABLE', code: 'NOT_MOUNTED', arrange: unmountCleanly,
  },
  {
    name: 'directorio de montaje inexistente',
    state: 'UNAVAILABLE', code: 'NOT_MOUNTED',
    arrange: (w) => { unmountCleanly(w); w.probe.delete(MOUNTPOINT); },
  },
  {
    name: 'mountpoint es un enlace simbólico',
    state: 'NEEDS_CHECK', code: 'MOUNTPOINT_INVALID',
    arrange: (w) => {
      w.probe.set(MOUNTPOINT, { kind: 'symlink', dev: SD_ROOT, target: '/mnt/hdd' }).set('/mnt/hdd', { kind: 'directory', dev: HDD });
    },
  },
  {
    name: 'bind del FS del sistema en el mountpoint (namespace systemd sin HDD)',
    state: 'UNAVAILABLE', code: 'NOT_MOUNTED',
    arrange: (w) => {
      w.setMounts({ id: 41, parent: 22, dev: SD_ROOT, root: '/srv/pcloud', mountPoint: MOUNTPOINT, fsType: 'ext4', source: '/dev/mmcblk0p2' });
      w.probe.set(MOUNTPOINT, { kind: 'directory', dev: SD_ROOT });
    },
  },
  {
    name: 'dos montajes no apilados en la misma ruta',
    state: 'UNAVAILABLE', code: 'MOUNT_AMBIGUOUS',
    arrange: (w) => w.setMounts(hddMountLine('exfat'), hddMountLine('exfat', { id: 41 })),
  },
  {
    name: 'stat(mountpoint) no coincide con mountinfo (carrera de montaje)',
    state: 'UNAVAILABLE', code: 'MOUNT_CHANGED',
    arrange: (w) => w.probe.set(MOUNTPOINT, { kind: 'directory', dev: OTHER_DISK }),
  },
  {
    name: 'mountinfo ilegible',
    state: 'UNAVAILABLE', code: 'MOUNTINFO_UNREADABLE',
    arrange: (w) => w.probe.fail('readMountInfo', '/proc/self/mountinfo', 'EACCES'),
  },
  {
    name: 'mountinfo malformado',
    state: 'UNAVAILABLE', code: 'MOUNTINFO_UNREADABLE',
    arrange: (w) => { w.probe.mountinfo = 'esto no es mountinfo\n'; },
  },
  {
    name: 'HDD desconectado sin desmontar (montaje obsoleto)',
    state: 'UNAVAILABLE', code: 'DEVICE_ABSENT', arrange: unplugWithoutUnmount,
  },
  {
    name: 'otro disco montado y el configurado ausente',
    state: 'WRONG_VOLUME', code: 'SOURCE_MISMATCH',
    arrange: (w) => {
      w.setMounts(hddMountLine('exfat', { dev: OTHER_DISK, source: '/dev/sdb1' }));
      w.probe.set(MOUNTPOINT, { kind: 'directory', dev: OTHER_DISK }).delete(`/dev/disk/by-uuid/${FS_UUID}`, '/dev/sda1');
    },
  },
  {
    name: 'otro disco montado aunque el configurado está conectado',
    state: 'WRONG_VOLUME', code: 'SOURCE_MISMATCH',
    arrange: (w) => {
      w.setMounts(hddMountLine('exfat', { dev: OTHER_DISK, source: '/dev/sdb1' }));
      w.probe.set(MOUNTPOINT, { kind: 'directory', dev: OTHER_DISK });
    },
  },
  {
    name: 'ntfs-3g (FUSE) montando otro dispositivo',
    fsType: 'ntfs-3g', state: 'WRONG_VOLUME', code: 'SOURCE_MISMATCH',
    arrange: (w) => w.setMounts(hddMountLine('ntfs-3g', { source: '/dev/sdb1' })),
  },
  {
    name: 'bind de un subdirectorio del HDD en lugar del FS completo',
    state: 'NEEDS_CHECK', code: 'MOUNT_NOT_FS_ROOT',
    arrange: (w) => w.setMounts(hddMountLine('exfat', { root: '/backup' })),
  },
  {
    name: 'tipo de FS inesperado (vfat)',
    state: 'NEEDS_CHECK', code: 'FSTYPE_UNEXPECTED',
    arrange: (w) => w.setMounts(hddMountLine('exfat', { fsType: 'vfat' })),
  },
  {
    name: 'configurado ntfs3 pero montado con ntfs-3g',
    fsType: 'ntfs-3g', state: 'NEEDS_CHECK', code: 'FSTYPE_UNEXPECTED', options: { fsType: 'ntfs3' },
  },
  {
    name: 'ntfs3 montado con "force" (volumen sucio/hibernado)',
    fsType: 'ntfs3', state: 'NEEDS_CHECK', code: 'FORCED_MOUNT',
    arrange: (w) => w.setMounts(hddMountLine('ntfs3', { superOptions: 'rw,uid=998,gid=998,force' })),
  },
  {
    name: 'volumen aún no vinculado (sin marcador en config ni en disco)',
    state: 'NEEDS_CHECK', code: 'NOT_ONBOARDED', options: { volumeMarker: null },
    arrange: (w) => w.probe.delete(`${MOUNTPOINT}/.pcloud`, `${MOUNTPOINT}/.pcloud/volume-id`),
  },
  {
    name: 'falta .pcloud/ estando configurado el marcador',
    state: 'NEEDS_CHECK', code: 'MARKER_MISSING',
    arrange: (w) => w.probe.delete(`${MOUNTPOINT}/.pcloud`, `${MOUNTPOINT}/.pcloud/volume-id`),
  },
  {
    name: 'falta el fichero volume-id',
    state: 'NEEDS_CHECK', code: 'MARKER_MISSING',
    arrange: (w) => w.probe.delete(`${MOUNTPOINT}/.pcloud/volume-id`),
  },
  {
    name: 'marcador de otra instalación',
    state: 'WRONG_VOLUME', code: 'MARKER_MISMATCH',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'file', dev: w.volumeDev, content: `pcloud-volume-v1 ${OTHER_MARKER}\n` }),
  },
  {
    name: 'marcador corrupto',
    state: 'NEEDS_CHECK', code: 'MARKER_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'file', dev: w.volumeDev, content: 'pcloud-volume-v1 basura' }),
  },
  {
    name: 'marcador es un enlace simbólico',
    state: 'NEEDS_CHECK', code: 'MARKER_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'symlink', dev: w.volumeDev, target: '/etc/passwd' }),
  },
  {
    name: 'marcador gigante',
    state: 'NEEDS_CHECK', code: 'MARKER_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'file', dev: w.volumeDev, content: 'x'.repeat(5000) }),
  },
  {
    name: '.pcloud es un enlace simbólico',
    state: 'NEEDS_CHECK', code: 'INTERNAL_DIR_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud`, { kind: 'symlink', dev: w.volumeDev, target: '/var/tmp' }),
  },
  {
    name: '.pcloud en otro dispositivo (bind desde la microSD)',
    state: 'NEEDS_CHECK', code: 'INTERNAL_DIR_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/.pcloud`, { kind: 'directory', dev: SD_ROOT }),
  },
  {
    name: 'falta la raíz de datos',
    state: 'NEEDS_CHECK', code: 'DATA_ROOT_INVALID',
    arrange: (w) => w.probe.delete(`${MOUNTPOINT}/data`),
  },
  {
    name: 'raíz de datos es un enlace simbólico',
    state: 'NEEDS_CHECK', code: 'DATA_ROOT_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/data`, { kind: 'symlink', dev: w.volumeDev, target: '/home' }),
  },
  {
    name: 'raíz de datos en otro FS (bind desde la microSD)',
    state: 'NEEDS_CHECK', code: 'DATA_ROOT_INVALID',
    arrange: (w) => w.probe.set(`${MOUNTPOINT}/data`, { kind: 'directory', dev: SD_ROOT }),
  },
  {
    name: 'montado ro',
    state: 'READ_ONLY', code: 'MOUNT_READ_ONLY',
    arrange: (w) => w.setMounts(hddMountLine('exfat', { options: 'ro,nosuid,nodev,noexec,noatime' })),
  },
  {
    name: 'remontado ro por errores (errors=remount-ro)',
    state: 'READ_ONLY', code: 'MOUNT_READ_ONLY',
    arrange: (w) => w.setMounts(hddMountLine('exfat', { superOptions: 'ro,uid=998,gid=998,errors=remount-ro' })),
  },
  {
    name: 'kernel devuelve EROFS al comprobar escritura',
    state: 'READ_ONLY', code: 'MOUNT_READ_ONLY',
    arrange: (w) => w.probe.fail('checkWritable', `${MOUNTPOINT}/data`, 'EROFS'),
  },
  {
    name: 'uid/gid del montaje no permiten escribir al servicio',
    state: 'NEEDS_CHECK', code: 'PERMISSION_DENIED',
    arrange: (w) => w.probe.fail('checkWritable', `${MOUNTPOINT}/.pcloud`, 'EACCES'),
  },
  {
    name: 'EIO leyendo el marcador',
    state: 'UNHEALTHY', code: 'IO_ERROR',
    arrange: (w) => w.probe.fail('readTextFile', `${MOUNTPOINT}/.pcloud/volume-id`, 'EIO'),
  },
  {
    name: 'EIO en stat del mountpoint',
    state: 'UNHEALTHY', code: 'IO_ERROR',
    arrange: (w) => w.probe.fail('stat', MOUNTPOINT, 'EIO'),
  },
  {
    name: 'FUSE caído (ENOTCONN)',
    fsType: 'ntfs-3g', state: 'UNAVAILABLE', code: 'NOT_MOUNTED',
    arrange: (w) => w.probe.fail('stat', MOUNTPOINT, 'ENOTCONN'),
  },
  {
    name: 'excepción inesperada sin errno en la sonda',
    state: 'UNAVAILABLE', code: 'PROBE_FAILED',
    arrange: (w) => w.probe.fail('lstat', `${MOUNTPOINT}/.pcloud`, new TypeError('fallo imprevisto')),
  },
];

describe('StorageGuardian — matriz de fallos (falla en cerrado)', () => {
  for (const fault of FAULTS) {
    it(`${fault.name} → ${fault.state} ${fault.code}`, async () => {
      const world = healthyWorld(fault.fsType ?? 'exfat');
      fault.arrange?.(world);
      const guardian = createGuardian(world, fault.options);

      const snapshot = await guardian.check();
      assert.equal(snapshot.state, fault.state);
      assert.equal(snapshot.issues[0]?.code, fault.code);
      assert.notEqual(snapshot.state, 'READY');

      await assertRejectsStorage(guardian.assertWritableVolume(), fault.state);
      if (fault.state === 'READ_ONLY') {
        await guardian.assertReadableVolume();
      } else {
        await assertRejectsStorage(guardian.assertReadableVolume(), fault.state);
      }
    });
  }

  it('reintentable solo cuando el problema puede resolverse solo', async () => {
    const unplugged = healthyWorld();
    unplugWithoutUnmount(unplugged);
    assert.equal((await assertRejectsStorage(createGuardian(unplugged).assertWritableVolume())).retryable, true);

    const wrong = healthyWorld();
    wrong.probe.set(`${MOUNTPOINT}/.pcloud/volume-id`, { kind: 'file', dev: HDD, content: `pcloud-volume-v1 ${OTHER_MARKER}\n` });
    assert.equal((await assertRejectsStorage(createGuardian(wrong).assertWritableVolume())).retryable, false);
  });
});

describe('StorageGuardian — generaciones y leases', () => {
  it('comprobaciones repetidas sin cambios no alteran la generación', async () => {
    const guardian = createGuardian(healthyWorld());
    const first = await guardian.check();
    const second = await guardian.check();
    assert.equal(first.generation, second.generation);
  });

  it('revalidate falla si el disco se desconecta durante la operación', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    const lease = await guardian.assertWritableVolume();
    unplugWithoutUnmount(world);
    const error = await assertRejectsStorage(guardian.revalidate(lease));
    assert.equal(error.retryable, true);
  });

  it('revalidate falla tras desmontar y volver a montar el mismo disco (nuevo montaje)', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    const lease = await guardian.assertWritableVolume();
    world.setMounts(hddMountLine('exfat', { id: 52 }));
    const snapshot = await guardian.check();
    assert.equal(snapshot.state, 'READY');
    assert.ok(snapshot.generation > lease.generation);
    await assertRejectsStorage(guardian.revalidate(lease), 'READY');
  });

  it('una caída observada invalida el lease aunque el disco vuelva idéntico', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    const lease = await guardian.assertWritableVolume();
    world.probe.fail('stat', MOUNTPOINT, 'EIO');
    assert.equal((await guardian.check()).state, 'UNHEALTHY');
    world.probe.clearFailures(); // el mismo disco vuelve, con el mismo id de montaje
    const recovered = await guardian.check();
    assert.equal(recovered.state, 'READY');
    assert.equal(recovered.identity, (await guardian.check()).identity);
    await assertRejectsStorage(guardian.revalidate(lease), 'READY');
  });

  it('un lease de lectura sobrevive en READ_ONLY pero no uno de escritura', async () => {
    const world = healthyWorld();
    world.setMounts(hddMountLine('exfat', { options: 'ro,nosuid,nodev,noexec,noatime' }));
    const guardian = createGuardian(world);
    const readLease = await guardian.assertReadableVolume();
    await guardian.revalidate(readLease);
    await assertRejectsStorage(guardian.assertWritableVolume(), 'READ_ONLY');
  });

  it('onChange solo se dispara en transiciones', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    const seen: VolumeState[] = [];
    guardian.onChange((snapshot) => seen.push(snapshot.state));
    await guardian.check();
    await guardian.check();
    unmountCleanly(world);
    await guardian.check();
    await guardian.check();
    assert.deepEqual(seen, ['READY', 'UNAVAILABLE']);
  });

  it('un fallo imprevisto se entrega a su llamante pero no bloquea las evaluaciones siguientes', async () => {
    let calls = 0;
    const guardian = createGuardian(healthyWorld(), {
      clock: () => {
        calls += 1;
        if (calls === 3) throw new Error('reloj roto');
        return new Date('2026-11-13T12:00:00.000Z');
      },
    });
    assert.equal((await guardian.check()).state, 'READY'); // reloj: constructor (1) + publicación (2)
    await assert.rejects(guardian.check(), /reloj roto/); // la publicación (3) falla: el llamante lo ve
    assert.equal((await guardian.check()).state, 'READY'); // la cola sigue viva
    await guardian.assertWritableVolume();
  });

  it('un listener que lanza no rompe la evaluación', async () => {
    const guardian = createGuardian(healthyWorld());
    guardian.onChange(() => {
      throw new Error('listener roto');
    });
    assert.equal((await guardian.check()).state, 'READY');
  });
});

describe('StorageGuardian — onboarding', () => {
  it('permite vincular un volumen montado sin marcador', async () => {
    const world = healthyWorld();
    world.probe.delete(`${MOUNTPOINT}/.pcloud`, `${MOUNTPOINT}/.pcloud/volume-id`, `${MOUNTPOINT}/data`);
    const guardian = createGuardian(world, { volumeMarker: null });
    const lease = await guardian.acquire('onboarding');
    assert.equal(lease.kind, 'onboarding');
    await assertRejectsStorage(guardian.assertWritableVolume(), 'NEEDS_CHECK');
  });

  it('informa del marcador existente para readoptarlo (reinstalación / DB perdida)', async () => {
    const guardian = createGuardian(healthyWorld(), { volumeMarker: null });
    const snapshot = await guardian.check();
    assert.equal(snapshot.issues[0]?.code, 'NOT_ONBOARDED');
    assert.equal(snapshot.issues[0]?.detail?.['existingMarker'], MARKER);
  });

  it('no permite onboarding de un volumen en READY, de solo lectura o equivocado', async () => {
    await assertRejectsStorage(createGuardian(healthyWorld()).acquire('onboarding'), 'READY');

    const readOnly = healthyWorld();
    readOnly.setMounts(hddMountLine('exfat', { options: 'ro,nosuid,nodev,noexec,noatime' }));
    readOnly.probe.delete(`${MOUNTPOINT}/.pcloud`, `${MOUNTPOINT}/.pcloud/volume-id`);
    await assertRejectsStorage(createGuardian(readOnly, { volumeMarker: null }).acquire('onboarding'));

    const unplugged = healthyWorld();
    unplugWithoutUnmount(unplugged);
    await assertRejectsStorage(createGuardian(unplugged, { volumeMarker: null }).acquire('onboarding'), 'UNAVAILABLE');
  });
});

describe('StorageGuardian — concurrencia', () => {
  it('las llamadas concurrentes comparten la evaluación siguiente, nunca una ya empezada', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    let release!: () => void;
    world.probe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = guardian.check();
    await new Promise((resolve) => setImmediate(resolve)); // la 1ª evaluación ya está en curso
    const second = guardian.check();
    const third = guardian.check();
    assert.equal(second, third);
    assert.notEqual(first, second);

    release();
    await Promise.all([first, second, third]);
    const reads = world.probe.calls.filter((call) => call.op === 'readMountInfo').length;
    assert.equal(reads, 2);
  });

  it('una evaluación lanzada tras un cambio lo refleja', async () => {
    const world = healthyWorld();
    const guardian = createGuardian(world);
    const before = guardian.check();
    unmountCleanly(world);
    const after = guardian.check();
    assert.equal((await after).state, 'UNAVAILABLE');
    await before;
  });
});

describe('StorageGuardian — disco que deja de responder (incidente 2026-11-14)', () => {
  it('peticiones en curso sin completarse durante stallMs → UNHEALTHY IO_STALLED; al avanzar, READY', async () => {
    const world = healthyWorld();
    let now = 0;
    const guardian = createGuardian(world, { stallMs: 20_000, recoveryMs: 60_000, monotonic: () => now });
    world.probe.blockStats = { completed: 1000, inFlight: 0 };
    assert.equal((await guardian.check()).state, 'READY');
    world.probe.blockStats = { completed: 1005, inFlight: 2 };
    assert.equal((await guardian.check()).state, 'READY', 'primera muestra con peticiones en curso');
    now = 15_000;
    assert.equal((await guardian.check()).state, 'READY', 'aún no supera el umbral');
    now = 21_000;
    const stalled = await guardian.check();
    assert.equal(stalled.state, 'UNHEALTHY');
    assert.equal(stalled.issues[0]?.code, 'IO_STALLED');
    await assertRejectsStorage(guardian.assertWritableVolume(), 'UNHEALTHY');
    await assertRejectsStorage(guardian.assertReadableVolume(), 'UNHEALTHY');
    world.probe.blockStats = { completed: 1010, inFlight: 0 };
    now = 22_000;
    const holding = await guardian.check();
    assert.equal(holding.state, 'UNHEALTHY', 'recién recuperado: no vuelve a READY al primer respiro');
    assert.equal(holding.issues[0]?.detail?.['recovering'], 'sí');
    now = 82_000;
    const recovered = await guardian.check();
    assert.equal(recovered.state, 'READY', 'tras 60 s estable, vuelve a READY');
    assert.ok(recovered.generation > stalled.generation, 'nueva generación: las operaciones anteriores no pueden confirmar');
  });

  it('una sonda que no termina a tiempo → UNHEALTHY IO_TIMEOUT rápido, sin apilar más sondas', async () => {
    const world = healthyWorld();
    let now = 0;
    const guardian = createGuardian(world, { probeTimeoutMs: 50, recoveryMs: 60_000, monotonic: () => now });
    assert.equal((await guardian.check()).state, 'READY');
    let release!: () => void;
    world.probe.lstatGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = Date.now();
    const hung = await guardian.check();
    assert.equal(hung.state, 'UNHEALTHY');
    assert.equal(hung.issues[0]?.code, 'IO_TIMEOUT');
    const callsBefore = world.probe.calls.length;
    for (let i = 0; i < 5; i++) assert.equal((await guardian.check()).state, 'UNHEALTHY');
    assert.equal(world.probe.calls.length, callsBefore, 'mientras la sonda siga atascada no se lanza otra');
    assert.ok(Date.now() - started < 2000, 'las comprobaciones siguientes responden al instante');
    await assertRejectsStorage(guardian.assertWritableVolume(), 'UNHEALTHY');

    world.probe.lstatGate = null;
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await guardian.check()).state, 'UNHEALTHY', 'recién recuperado: periodo de estabilidad');
    now = 61_000;
    assert.equal((await guardian.check()).state, 'READY', 'tras el periodo estable, se recupera');
  });
});

describe('StorageGuardian — validación de opciones', () => {
  const base = healthyWorld();
  const cases: Array<[string, Partial<StorageGuardianOptions>]> = [
    ['mountpoint relativo', { mountpoint: 'srv/pcloud' }],
    ['mountpoint "/"', { mountpoint: '/' }],
    ['mountpoint con barra final', { mountpoint: '/srv/pcloud/' }],
    ['raíz de datos con ..', { dataRootRelative: '../etc' }],
    ['raíz de datos absoluta', { dataRootRelative: '/data' }],
    ['raíz de datos dentro de .pcloud', { dataRootRelative: '.pcloud/data' }],
    ['UUID con barras (inyección de ruta)', { expectedFsUuid: '../../sda1' }],
  ];
  for (const [name, options] of cases) {
    it(`rechaza ${name}`, () => {
      assert.throws(() => createGuardian(base, options), TypeError);
    });
  }
});
