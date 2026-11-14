import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { ItemResult } from '@pcloud/contracts';
import { AppError } from '../../src/errors.ts';
import type { FsOperations } from '../../src/storage/operations.ts';
import { StorageUnavailableError } from '../../src/storage/storage-guardian.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

function okPaths(results: ItemResult[]): string[] {
  return results.map((result) => (result.ok ? result.path : `ERROR:${result.code}`));
}

/** Contenido de un árbol como mapa ruta relativa → sha256 (carpetas: «dir»). */
async function snapshot(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      Object.assign(out, await snapshot(path.join(dir, entry.name), `${rel}/`));
    } else {
      out[rel] = sha(await readFile(path.join(dir, entry.name)));
    }
  }
  return out;
}

describe('FsOperations', () => {
  let h: Harness;
  let ops: FsOperations;
  const data = (...parts: string[]): string => path.join(h.dataRoot, ...parts);

  beforeEach(async () => {
    h = await createHarness();
    ops = h.operations();
    await mkdir(data('Fotos', '2026'), { recursive: true });
    await writeFile(data('Fotos', '2026', 'playa.jpg'), randomBytes(5000));
    await writeFile(data('Fotos', 'portada.png'), 'png');
    await writeFile(data('informe.pdf'), 'pdf v1');
    await mkdir(data('Documentos'));
  });

  afterEach(async () => {
    await h.dispose();
  });

  describe('crear archivo', () => {
    it('crea un archivo vacío y nunca sustituye uno existente (sin distinguir mayúsculas)', async () => {
      assert.deepEqual(await ops.createFile('/Documentos', 'notas.txt'), { path: '/Documentos/notas.txt', name: 'notas.txt' });
      assert.equal((await stat(data('Documentos', 'notas.txt'))).size, 0);
      await writeFile(data('Documentos', 'notas.txt'), 'contenido');
      await rejectsWith(ops.createFile('/Documentos', 'NOTAS.TXT'), 'CONFLICT');
      assert.equal(await readFile(data('Documentos', 'notas.txt'), 'utf8'), 'contenido');
    });

    it('aplica la política de nombres y falla en cerrado sin disco', async () => {
      await rejectsWith(ops.createFile('/', 'a:b.txt'), 'INVALID_NAME');
      await rejectsWith(ops.createFile('/', 'CON.txt'), 'INVALID_NAME');
      await rejectsWith(ops.createFile('/no-existe', 'a.txt'), 'NOT_FOUND');
      h.gate.disconnect();
      await assert.rejects(ops.createFile('/', 'a.txt'), StorageUnavailableError);
    });
  });

  describe('renombrar', () => {
    it('renombra archivos y carpetas; 409 si el nombre está ocupado, sin tocar nada', async () => {
      assert.deepEqual(await ops.rename('/informe.pdf', 'informe final.pdf'), { path: '/informe final.pdf', name: 'informe final.pdf' });
      assert.equal(await readFile(data('informe final.pdf'), 'utf8'), 'pdf v1');
      await ops.rename('/Fotos', 'Imágenes');
      assert.equal((await readdir(data('Imágenes', '2026'))).length, 1);
      await rejectsWith(ops.rename('/informe final.pdf', 'documentos'), 'CONFLICT');
      assert.equal(await readFile(data('informe final.pdf'), 'utf8'), 'pdf v1');
      await rejectsWith(ops.rename('/', 'raiz'), 'INVALID_PATH');
      await rejectsWith(ops.rename('/informe final.pdf', 'mal/nombre'), 'INVALID_NAME');
    });

    it('cambiar solo mayúsculas funciona (en exFAT es el mismo nombre) y no deja restos', async () => {
      await ops.rename('/informe.pdf', 'Informe.PDF');
      const names = await readdir(h.dataRoot);
      assert.ok(names.includes('Informe.PDF'), names.join());
      assert.ok(!names.includes('informe.pdf'));
      assert.equal(await readFile(data('Informe.PDF'), 'utf8'), 'pdf v1');
      assert.deepEqual(await readdir(h.stagingDir), []);
    });

    it('recover() completa un renombrado en dos pasos interrumpido por un corte', async () => {
      // Estado tras un corte entre los dos renames: el elemento está en staging con su intención.
      await rename(data('informe.pdf'), path.join(h.stagingDir, 'abc.renaming'));
      await writeFile(path.join(h.stagingDir, 'abc.rename.json'), JSON.stringify({ v: 1, tmp: 'abc.renaming', target: ['Informe.pdf'] }));
      await ops.recover();
      assert.equal(await readFile(data('Informe.pdf'), 'utf8'), 'pdf v1');
      assert.deepEqual(await readdir(h.stagingDir), []);
    });
  });

  describe('mover', () => {
    it('mueve varios elementos; si el nombre existe en el destino usa «nombre (2)»', async () => {
      await writeFile(data('Documentos', 'informe.pdf'), 'pdf antiguo');
      const results = await ops.move(['/informe.pdf', '/Fotos/portada.png'], '/Documentos');
      assert.deepEqual(okPaths(results), ['/Documentos/informe (2).pdf', '/Documentos/portada.png']);
      assert.equal(await readFile(data('Documentos', 'informe.pdf'), 'utf8'), 'pdf antiguo', 'nunca sobrescribe');
      assert.equal(await readFile(data('Documentos', 'informe (2).pdf'), 'utf8'), 'pdf v1');
    });

    it('rechaza mover una carpeta dentro de sí misma; mover a su misma carpeta no hace nada', async () => {
      const results = await ops.move(['/Fotos', '/informe.pdf'], '/Fotos/2026');
      assert.equal(results[0]?.ok, false);
      assert.equal(results[0]?.ok === false && results[0].code, 'INVALID_PATH');
      assert.equal(results[1]?.ok, true, 'un fallo no impide el resto del lote');
      assert.deepEqual(okPaths(await ops.move(['/Fotos/portada.png'], '/Fotos')), ['/Fotos/portada.png']);
    });

    it('un elemento inexistente falla solo él; sin disco el lote se detiene', async () => {
      const results = await ops.move(['/no-existe.txt', '/informe.pdf'], '/Documentos');
      assert.deepEqual(okPaths(results), ['ERROR:NOT_FOUND', '/Documentos/informe.pdf']);
      h.gate.disconnect();
      await assert.rejects(ops.move(['/Documentos/informe.pdf'], '/'), StorageUnavailableError);
    });
  });

  describe('copiar', () => {
    it('copia árboles completos con el mismo contenido y fechas, sin restos en staging', async () => {
      const old = new Date('2020-05-01T10:00:00Z');
      await utimes(data('Fotos', '2026', 'playa.jpg'), old, old);
      const before = await snapshot(data('Fotos'));
      assert.deepEqual(okPaths(await ops.copy(['/Fotos'], '/Documentos')), ['/Documentos/Fotos']);
      assert.deepEqual(await snapshot(data('Documentos', 'Fotos')), before);
      assert.deepEqual(await snapshot(data('Fotos')), before, 'el original no cambia');
      assert.equal((await stat(data('Documentos', 'Fotos', '2026', 'playa.jpg'))).mtime.getTime(), old.getTime());
      assert.deepEqual(await readdir(h.stagingDir), []);
    });

    it('copiar en la misma carpeta crea «nombre (2)»; una carpeta no se copia dentro de sí misma', async () => {
      assert.deepEqual(okPaths(await ops.copy(['/informe.pdf', '/informe.pdf'], '/')), ['/informe (2).pdf', '/informe (3).pdf']);
      const results = await ops.copy(['/Fotos'], '/Fotos/2026');
      assert.equal(results[0]?.ok === false && results[0].code, 'INVALID_PATH');
      assert.deepEqual(await readdir(h.stagingDir), []);
    });

    it('sin espacio suficiente no copia nada', async () => {
      const tight = h.operations({ minFreeBytes: Number.MAX_SAFE_INTEGER });
      const results = await tight.copy(['/informe.pdf'], '/Documentos');
      assert.equal(results[0]?.ok === false && results[0].code, 'INSUFFICIENT_STORAGE');
      assert.deepEqual(await readdir(data('Documentos')), []);
    });

    it('recover() descarta copias interrumpidas en staging sin tocar los datos', async () => {
      await mkdir(path.join(h.stagingDir, 'x.copy', 'sub'), { recursive: true });
      await writeFile(path.join(h.stagingDir, 'x.copy', 'sub', 'a.bin'), 'parcial');
      await writeFile(path.join(h.stagingDir, 'subida.part'), 'de una subida: no se toca');
      await ops.recover();
      assert.deepEqual(await readdir(h.stagingDir), ['subida.part']);
      assert.equal(await readFile(data('informe.pdf'), 'utf8'), 'pdf v1');
    });
  });

  describe('papelera', () => {
    it('eliminar mueve a la papelera; restaurar lo devuelve intacto a su sitio', async () => {
      const before = await snapshot(data('Fotos'));
      const results = await ops.trash(['/Fotos', '/informe.pdf'], 1);
      assert.ok(results.every((result) => result.ok));
      assert.deepEqual((await readdir(h.dataRoot)).sort(), ['Documentos']);

      const list = await ops.listTrash();
      assert.equal(list.entries.length, 2);
      const fotos = list.entries.find((entry) => entry.name === 'Fotos');
      assert.equal(fotos?.originalPath, '/Fotos');
      assert.equal(fotos?.type, 'dir');
      assert.equal(fotos?.size, 5003);
      assert.ok(fotos?.expiresAt !== null);

      assert.deepEqual(okPaths(await ops.restore(list.entries.map((entry) => entry.id))).sort(), ['/Fotos', '/informe.pdf']);
      assert.deepEqual(await snapshot(data('Fotos')), before);
      assert.equal((await ops.listTrash()).entries.length, 0);
      assert.deepEqual(await readdir(path.join(h.root, '.pcloud', 'trash')), []);
    });

    it('restaurar con el nombre ocupado usa «nombre (2)»; si la carpeta original ya no existe, la recrea', async () => {
      await ops.trash(['/Fotos/2026/playa.jpg', '/informe.pdf'], 1);
      await rename(data('Fotos'), data('Otra'));
      await writeFile(data('informe.pdf'), 'nuevo');
      const ids = (await ops.listTrash()).entries.map((entry) => entry.id);
      assert.deepEqual(okPaths(await ops.restore(ids)).sort(), ['/Fotos/2026/playa.jpg', '/informe (2).pdf']);
      assert.equal(await readFile(data('informe.pdf'), 'utf8'), 'nuevo', 'nunca sobrescribe al restaurar');
    });

    it('borrado definitivo solo dentro de la papelera; caducidad por antigüedad', async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      const timed = h.operations({ clock: () => now, trashRetentionDays: 30 });
      await timed.trash(['/informe.pdf'], 1);
      now = new Date('2026-01-20T00:00:00Z');
      await timed.trash(['/Fotos/portada.png'], 1);
      now = new Date('2026-02-05T00:00:00Z');
      assert.equal(await timed.purgeExpired(), 1, 'solo el que supera 30 días');
      const left = await timed.listTrash();
      assert.deepEqual(left.entries.map((entry) => entry.name), ['portada.png']);
      assert.equal(await timed.purge(['../../data', 'no-valido', left.entries[0]?.id ?? '']), 1, 'ids no válidos se ignoran');
      assert.equal(await timed.emptyTrash(), 0);
      assert.ok((await readdir(h.dataRoot)).includes('Fotos'), 'los datos fuera de la papelera siguen ahí');
    });

    it('caducidad: sin hora fiable no se elimina nada; los elementos «del futuro» nunca caducan', async () => {
      let now = new Date('2026-01-01T00:00:00Z');
      let trusted = false;
      const timed = h.operations({ clock: () => now, trashRetentionDays: 30, clockTrusted: async () => trusted });
      await timed.trash(['/informe.pdf'], 1);
      now = new Date('2026-03-01T00:00:00Z');
      assert.equal(await timed.purgeExpired(), 0, 'reloj no sincronizado: no se borra');
      trusted = true;
      // Un elemento eliminado con el reloj adelantado (fecha posterior a «ahora»).
      const future = path.join(h.root, '.pcloud', 'trash', `${new Date('2027-01-01T00:00:00Z').getTime()}-cafecafe`);
      await mkdir(future);
      await writeFile(path.join(future, 'meta.json'), '{}');
      await writeFile(path.join(future, 'item'), 'x');
      assert.equal(await timed.purgeExpired(), 1, 'solo el caducado de verdad');
      assert.ok((await readdir(path.join(h.root, '.pcloud', 'trash'))).includes(path.basename(future)));
    });

    it('recover() retira entradas sin elemento (corte antes del rename) y respeta las completas', async () => {
      await ops.trash(['/informe.pdf'], 1);
      const orphan = path.join(h.root, '.pcloud', 'trash', '1700000000000-deadbeef');
      await mkdir(orphan);
      await writeFile(path.join(orphan, 'meta.json'), '{}');
      await ops.recover();
      const ids = await readdir(path.join(h.root, '.pcloud', 'trash'));
      assert.equal(ids.length, 1);
      assert.notEqual(ids[0], '1700000000000-deadbeef');
    });

    it('sin disco no se puede eliminar ni restaurar', async () => {
      h.gate.disconnect();
      await assert.rejects(ops.trash(['/informe.pdf'], 1), StorageUnavailableError);
      await assert.rejects(ops.listTrash(), StorageUnavailableError);
    });
  });
});
