import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bindVolumeInYaml } from '../../src/config/bind-volume.ts';
import { ConfigError, parseConfig } from '../../src/config/config.ts';
import { writeFileAtomic } from '../../src/fs/durability.ts';

const EXAMPLE = new URL('../../../../deploy/config/config.example.yaml', import.meta.url);
const MARKER = '3f1c2b7e-8d4a-4c1e-9a2b-5d6e7f8a9b0c';

describe('bindVolumeInYaml', () => {
  it('vincula el volumen conservando comentarios y el resto de valores', async () => {
    const original = await readFile(EXAMPLE, 'utf8');
    const result = bindVolumeInYaml(original, { fsUuid: '1A2B-3C4D', volumeMarker: MARKER, fsType: 'exfat' });
    assert.equal(result.changed, true);
    assert.equal(result.config.storage.expectedFsUuid, '1A2B-3C4D');
    assert.equal(result.config.storage.volumeMarker, MARKER);
    assert.match(result.text, /expected_fs_uuid: 1A2B-3C4D\s+# p\. ej\./);
    assert.match(result.text, /# Valores iniciales para PROBAR y AJUSTAR/);
    assert.equal(parseConfig(result.text).transfers.chunkSizeMib, 8);
    assert.equal(original.split('\n').length, result.text.split('\n').length, 'no debe añadir ni quitar líneas');
  });

  it('es idempotente', async () => {
    const once = bindVolumeInYaml(await readFile(EXAMPLE, 'utf8'), { fsUuid: '1A2B-3C4D', volumeMarker: MARKER, fsType: 'exfat' });
    const twice = bindVolumeInYaml(once.text, { fsUuid: '1A2B-3C4D', volumeMarker: MARKER, fsType: 'exfat' });
    assert.equal(twice.changed, false);
    assert.equal(twice.text, once.text);
  });

  it('se niega a sustituir otro volumen ya vinculado', async () => {
    const bound = bindVolumeInYaml(await readFile(EXAMPLE, 'utf8'), { fsUuid: '5E6F-7A8B', volumeMarker: MARKER, fsType: 'exfat' });
    assert.throws(
      () => bindVolumeInYaml(bound.text, { fsUuid: '1A2B-3C4D', volumeMarker: MARKER, fsType: 'exfat' }),
      ConfigError,
    );
    assert.throws(
      () => bindVolumeInYaml(bound.text, { fsUuid: '1A2B-3C4D', volumeMarker: '9e8d7c6b-5a49-4382-a716-0f1e2d3c4b5a', fsType: 'exfat' }),
      ConfigError,
    );
  });

  it('un UUID NTFS solo con dígitos sigue siendo texto tras serializar', () => {
    const result = bindVolumeInYaml('storage:\n  fs_type: exfat\n', {
      fsUuid: '0123456789012345',
      volumeMarker: MARKER,
      fsType: 'ntfs3',
    });
    assert.equal(parseConfig(result.text).storage.expectedFsUuid, '0123456789012345');
  });

  it('rechaza YAML inválido', () => {
    assert.throws(() => bindVolumeInYaml('storage: [\n', { fsUuid: '1A2B-3C4D', volumeMarker: MARKER, fsType: 'exfat' }), ConfigError);
  });
});

describe('writeFileAtomic', () => {
  it('sustituye el contenido, conserva el modo y no deja temporales', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pcloud-atomic-'));
    try {
      const target = path.join(dir, 'config.yaml');
      await writeFile(target, 'antes\n', { mode: 0o640 });
      const modeBefore = (await stat(target)).mode & 0o777;
      await writeFileAtomic(target, 'después\n');
      assert.equal(await readFile(target, 'utf8'), 'después\n');
      if (process.platform !== 'win32') assert.equal((await stat(target)).mode & 0o777, modeBefore);
      assert.deepEqual(await readdir(dir), ['config.yaml']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
