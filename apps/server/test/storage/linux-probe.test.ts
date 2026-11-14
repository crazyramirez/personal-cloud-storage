/**
 * Integración con el kernel real (solo Linux; se omite en otros SO).
 * Verifica que la decodificación de dev_t coincide con /proc/self/mountinfo, que es la
 * base de las comprobaciones 6 y 8 del StorageGuardian. Solo lectura.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sameDevice } from '../../src/storage/device-number.ts';
import { LinuxStorageProbe } from '../../src/storage/linux-probe.ts';
import { findTopMount, parseMountInfo } from '../../src/storage/mountinfo.ts';

const linuxOnly = { skip: process.platform !== 'linux' ? 'requiere Linux' : false };

describe('LinuxStorageProbe (kernel real)', linuxOnly, () => {
  const probe = new LinuxStorageProbe();

  it('parsea el mountinfo real completo', async () => {
    const entries = parseMountInfo(await probe.readMountInfo());
    assert.ok(entries.length > 3);
  });

  it('stat("/").dev coincide con el major:minor del montaje raíz', async () => {
    const top = findTopMount(parseMountInfo(await probe.readMountInfo()), '/');
    assert.equal(top.kind, 'found');
    const info = await probe.stat('/');
    assert.ok(info !== null && top.kind === 'found');
    assert.ok(sameDevice(info.dev, top.entry), `stat=${info.dev.major}:${info.dev.minor}`);
  });

  it('el rdev del dispositivo de bloques raíz coincide con mountinfo', async (t) => {
    const top = findTopMount(parseMountInfo(await probe.readMountInfo()), '/');
    if (top.kind !== 'found' || !top.entry.source.startsWith('/dev/')) return t.skip('raíz sin dispositivo de bloques');
    const device = await probe.stat(top.entry.source);
    assert.equal(device?.kind, 'block-device');
    assert.ok(device !== null && sameDevice(device.rdev, top.entry));
  });

  it('lstat no sigue enlaces y realpath sí', async (t) => {
    const links = '/dev/disk/by-uuid';
    const info = await probe.lstat(links);
    if (info === null) return t.skip(`${links} no existe`);
    const real = await probe.realpath('/proc/self');
    assert.match(real ?? '', /^\/proc\/\d+$/);
    assert.equal((await probe.lstat('/proc/self'))?.kind, 'symlink');
  });

  it('readTextFile rechaza enlaces simbólicos (O_NOFOLLOW)', async () => {
    await assert.rejects(probe.readTextFile('/proc/self/root', 64), (error: NodeJS.ErrnoException) =>
      ['ELOOP', 'EISDIR', 'ENOTDIR'].includes(error.code ?? ''),
    );
  });

  it('lee los contadores de bloque del dispositivo de la raíz (detector de disco bloqueado)', async () => {
    const info = await probe.stat('/');
    assert.ok(info !== null);
    const stats = await probe.readBlockStats(info.dev);
    // En contenedores o sistemas sin /sys/dev/block puede no existir: entonces null, nunca excepción.
    if (stats !== null) {
      assert.ok(Number.isInteger(stats.completed) && stats.completed > 0, `completed=${stats.completed}`);
      assert.ok(Number.isInteger(stats.inFlight) && stats.inFlight >= 0);
    }
    assert.equal(await probe.readBlockStats({ major: 4095, minor: 1048575 }), null, 'dispositivo inexistente → null');
  });

  it('las rutas inexistentes devuelven null', async () => {
    assert.equal(await probe.lstat('/no/existe/pcloud'), null);
    assert.equal(await probe.stat('/no/existe/pcloud'), null);
    assert.equal(await probe.realpath('/no/existe/pcloud'), null);
  });
});
