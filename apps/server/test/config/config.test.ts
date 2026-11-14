import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { ConfigError, parseConfig, validateConfig } from '../../src/config/config.ts';

const EXAMPLE = new URL('../../../../deploy/config/config.example.yaml', import.meta.url);

function problemsOf(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ConfigError, String(error));
    return error.problems;
  }
  assert.fail('se esperaba ConfigError');
}

describe('configuración', () => {
  it('el ejemplo del repositorio es válido y conserva los valores de la spec', async () => {
    const config = parseConfig(await readFile(EXAMPLE, 'utf8'), 'config.example.yaml');
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.storage.mountpoint, '/srv/pcloud');
    assert.equal(config.storage.rootRelative, 'data');
    assert.equal(config.storage.expectedFsUuid, null);
    assert.equal(config.storage.volumeMarker, null);
    assert.equal(config.storage.fsType, 'exfat');
    assert.equal(config.transfers.chunkSizeMib, 8);
    assert.equal(config.trash.retentionDays, 30);
    assert.equal(config.storage.versioningEnabled, false);
  });

  it('un fichero vacío produce los valores por defecto', () => {
    const config = parseConfig('');
    assert.equal(config.storage.minFreeBytes, 10 * 1024 ** 3);
    assert.equal(config.paths.stateDir, '/var/lib/pcloud');
  });

  it('acepta UUID reales de exFAT, NTFS y estándar', () => {
    for (const uuid of ['1A2B-3C4D', '0123456789ABCDEF', '8a1d6b0e-55c2-4c4f-9f0a-1b2c3d4e5f60']) {
      assert.equal(validateConfig({ storage: { expected_fs_uuid: uuid } }).storage.expectedFsUuid, uuid);
    }
  });

  it('rechaza claves desconocidas con su ruta', () => {
    const problems = problemsOf(() => parseConfig('trash:\n  retention_day: 30\nfoo: 1\n'));
    assert.ok(problems.some((p) => p.startsWith('trash.retention_day: clave desconocida')));
    assert.ok(problems.some((p) => p.startsWith('foo: sección desconocida')));
  });

  it('explica por qué se eliminaron las opciones inseguras de la spec', () => {
    const problems = problemsOf(() =>
      parseConfig('storage:\n  on_missing_volume: read_only_api_no_deletes\nsecurity:\n  require_auth: true\n'),
    );
    assert.ok(problems.some((p) => p.includes('on_missing_volume') && p.includes('no es configurable')));
    assert.ok(problems.some((p) => p.includes('require_auth') && p.includes('obligatoria')));
  });

  it('rechaza los marcadores de posición de la spec', () => {
    const problems = problemsOf(() =>
      parseConfig(
        'storage:\n  fs_type: exfat_or_ntfs3\n  expected_fs_uuid: REEMPLAZAR\n  volume_marker: REEMPLAZAR_EN_ONBOARDING\n',
      ),
    );
    assert.equal(problems.length, 3);
  });

  const invalid: Array<[string, unknown]> = [
    ['UUID con ruta', { storage: { expected_fs_uuid: '../../dev/sda1' } }],
    ['mountpoint relativo', { storage: { mountpoint: 'srv/pcloud' } }],
    ['mountpoint raíz', { storage: { mountpoint: '/' } }],
    ['mountpoint con barra final', { storage: { mountpoint: '/srv/pcloud/' } }],
    ['root_relative con ..', { storage: { root_relative: '../otra' } }],
    ['root_relative dentro de .pcloud', { storage: { root_relative: '.pcloud/x' } }],
    ['state_dir dentro del HDD', { paths: { state_dir: '/srv/pcloud/db' } }],
    ['marcador sin UUID', { storage: { volume_marker: '3f1c2b7e-8d4a-4c1e-9a2b-5d6e7f8a9b0c' } }],
    ['puerto 0', { server: { port: 0 } }],
    ['host no IP', { server: { host: 'localhost' } }],
    ['chunk 0', { transfers: { chunk_size_mib: 0 } }],
    ['booleano como texto', { trash: { enabled: 'yes' } }],
    ['sección no objeto', { storage: 'x' }],
  ];
  for (const [name, raw] of invalid) {
    it(`rechaza ${name}`, () => {
      assert.ok(problemsOf(() => validateConfig(raw)).length > 0);
    });
  }

  it('rechaza YAML con claves duplicadas', () => {
    assert.throws(() => parseConfig('server:\n  port: 1\n  port: 2\n'), ConfigError);
  });
});
