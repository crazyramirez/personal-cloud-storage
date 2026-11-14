import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { onboardVolume, OnboardingError, type OnboardingGuardian } from '../../src/storage/onboarding.ts';
import type { VolumeLease, VolumeSnapshot } from '../../src/storage/storage-guardian.ts';
import { parseVolumeMarker } from '../../src/storage/volume-marker.ts';

const ID = '3f1c2b7e-8d4a-4c1e-9a2b-5d6e7f8a9b0c';

interface StubOptions {
  existingMarker?: string;
  acquireError?: Error;
  onRevalidate?: () => Promise<void>;
}

function stubGuardian(mountPoint: string, options: StubOptions = {}): OnboardingGuardian & { revalidations: number } {
  const lease: VolumeLease = Object.freeze({
    kind: 'onboarding',
    generation: 1,
    mountPoint,
    internalDir: `${mountPoint}/.pcloud`,
    dataRoot: `${mountPoint}/data`,
  });
  const detail = options.existingMarker === undefined ? undefined : { existingMarker: options.existingMarker };
  const current: VolumeSnapshot = {
    state: 'NEEDS_CHECK',
    issues: [detail === undefined ? { code: 'NOT_ONBOARDED', message: 'sin vincular' } : { code: 'NOT_ONBOARDED', message: 'sin vincular', detail }],
    generation: 1,
    checkedAt: '2026-11-13T12:00:00.000Z',
    mount: { mountPoint, source: '/dev/sda1', fsType: 'exfat', readOnly: false, options: ['rw'] },
    identity: '40|8:1|unbound',
  };
  const stub = {
    revalidations: 0,
    current,
    async acquire(): Promise<VolumeLease> {
      if (options.acquireError !== undefined) throw options.acquireError;
      return lease;
    },
    async revalidate(): Promise<void> {
      stub.revalidations += 1;
      await options.onRevalidate?.();
    },
  };
  return stub;
}

describe('onboardVolume', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'pcloud-onboard-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('crea .pcloud/{staging,trash,versions}, la raíz de datos y un marcador v1 válido', async () => {
    const guardian = stubGuardian(root);
    const result = await onboardVolume(guardian, { newMarkerId: () => ID });
    assert.equal(result.markerId, ID);
    assert.equal(result.adopted, false);
    assert.deepEqual((await readdir(path.join(root, '.pcloud'))).sort(), ['staging', 'trash', 'versions', 'volume-id']);
    assert.deepEqual(await readdir(path.join(root, 'data')), []);
    assert.equal(parseVolumeMarker(await readFile(path.join(root, '.pcloud', 'volume-id'), 'utf8')), ID);
    assert.equal(result.created.length, 6);
    assert.equal(guardian.revalidations, 1, 'debe revalidar justo antes de escribir el marcador');
  });

  it('usa un UUID v4 aleatorio por defecto', async () => {
    const result = await onboardVolume(stubGuardian(root));
    assert.match(result.markerId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('no deja ficheros temporales', async () => {
    await onboardVolume(stubGuardian(root), { newMarkerId: () => ID });
    const leftovers = (await readdir(path.join(root, '.pcloud'))).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });

  it('sin lease de onboarding no crea nada', async () => {
    const guardian = stubGuardian(root, { acquireError: new Error('estado READY') });
    await assert.rejects(onboardVolume(guardian), /estado READY/);
    assert.deepEqual(await readdir(root), []);
  });

  it('no readopta un marcador existente sin permiso explícito', async () => {
    await assert.rejects(onboardVolume(stubGuardian(root, { existingMarker: ID })), OnboardingError);
    assert.deepEqual(await readdir(root), []);
  });

  it('readopta con permiso explícito y solo crea lo que falta, sin tocar el marcador', async () => {
    await mkdir(path.join(root, '.pcloud'));
    await writeFile(path.join(root, '.pcloud', 'volume-id'), `pcloud-volume-v1 ${ID}\n`);
    const result = await onboardVolume(stubGuardian(root, { existingMarker: ID }), { adoptExistingMarker: true });
    assert.equal(result.adopted, true);
    assert.equal(result.markerId, ID);
    assert.ok(!result.created.some((entry) => entry.endsWith('.pcloud')), '.pcloud ya existía');
    assert.equal(await readFile(path.join(root, '.pcloud', 'volume-id'), 'utf8'), `pcloud-volume-v1 ${ID}\n`);
    assert.deepEqual((await readdir(path.join(root, '.pcloud'))).sort(), ['staging', 'trash', 'versions', 'volume-id']);
  });

  it('se detiene si .pcloud existe y no es un directorio', async () => {
    await writeFile(path.join(root, '.pcloud'), 'no soy un directorio');
    await assert.rejects(onboardVolume(stubGuardian(root), { newMarkerId: () => ID }), OnboardingError);
    assert.deepEqual(await readdir(root), ['.pcloud']);
  });

  it('si el volumen cambia antes de escribir el marcador, no lo escribe', async () => {
    const guardian = stubGuardian(root, {
      onRevalidate: async () => {
        throw new Error('generación cambiada');
      },
    });
    await assert.rejects(onboardVolume(guardian, { newMarkerId: () => ID }), /generación cambiada/);
    assert.ok(!(await readdir(path.join(root, '.pcloud'))).includes('volume-id'));
  });

  it('no sobrescribe un marcador que aparece durante la vinculación', async () => {
    const foreign = 'pcloud-volume-v1 9e8d7c6b-5a49-4382-a716-0f1e2d3c4b5a\n';
    const guardian = stubGuardian(root, {
      onRevalidate: async () => {
        await writeFile(path.join(root, '.pcloud', 'volume-id'), foreign);
      },
    });
    await assert.rejects(onboardVolume(guardian, { newMarkerId: () => ID }), OnboardingError);
    assert.equal(await readFile(path.join(root, '.pcloud', 'volume-id'), 'utf8'), foreign);
  });

  it('rechaza un identificador inválido antes de escribir nada en el marcador', async () => {
    await assert.rejects(onboardVolume(stubGuardian(root), { newMarkerId: () => 'no-es-uuid' }), TypeError);
    assert.ok(!(await readdir(path.join(root, '.pcloud'))).includes('volume-id'));
  });
});
