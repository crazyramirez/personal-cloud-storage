import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError } from '../../src/errors.ts';
import { measureSize } from '../../src/storage/size.ts';
import { createHarness, type Harness } from '../support/harness.ts';

describe('tamaño de carpetas (panel de detalles)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
    // Fotos/2026/verano/a.jpg (5) + Fotos/2026/b.jpg (3) + Fotos/c.txt (2), varios niveles.
    await mkdir(path.join(h.dataRoot, 'Fotos', '2026', 'verano'), { recursive: true });
    await mkdir(path.join(h.dataRoot, 'Fotos', 'vacía'));
    await writeFile(path.join(h.dataRoot, 'Fotos', '2026', 'verano', 'a.jpg'), '12345');
    await writeFile(path.join(h.dataRoot, 'Fotos', '2026', 'b.jpg'), '123');
    await writeFile(path.join(h.dataRoot, 'Fotos', 'c.txt'), '12');
    await writeFile(path.join(h.dataRoot, 'nota.txt'), '1234567');
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('suma todo el contenido, en todos los niveles', async () => {
    assert.deepEqual(await measureSize(h.dataRoot, ['/Fotos']), { bytes: 10, files: 3, folders: 3, complete: true });
    assert.deepEqual(await measureSize(h.dataRoot, ['/Fotos/2026']), { bytes: 8, files: 2, folders: 1, complete: true });
  });

  it('una selección de carpetas y archivos suma todo, sin contar dos veces', async () => {
    const result = await measureSize(h.dataRoot, ['/Fotos', '/nota.txt', '/Fotos/2026', '/Fotos']);
    assert.deepEqual(result, { bytes: 17, files: 4, folders: 3, complete: true });
  });

  it('la raíz no cuenta las carpetas reservadas', async () => {
    await mkdir(path.join(h.dataRoot, '.pcloud'), { recursive: true });
    await writeFile(path.join(h.dataRoot, '.pcloud', 'interno.bin'), 'x'.repeat(100));
    assert.deepEqual(await measureSize(h.dataRoot, ['/']), { bytes: 17, files: 4, folders: 4, complete: true });
    await assert.rejects(measureSize(h.dataRoot, ['/.pcloud']), (error: unknown) => error instanceof AppError && error.code === 'INVALID_PATH');
  });

  it('no sigue enlaces simbólicos', async (t) => {
    try {
      await symlink(path.join(h.dataRoot, 'Fotos'), path.join(h.dataRoot, 'Fotos', '2026', 'bucle'), 'dir');
    } catch {
      t.skip('el sistema no permite crear enlaces simbólicos');
      return;
    }
    assert.deepEqual(await measureSize(h.dataRoot, ['/Fotos']), { bytes: 10, files: 3, folders: 3, complete: true });
  });

  it('una ruta que no existe es un error, no un total a medias', async () => {
    await assert.rejects(measureSize(h.dataRoot, ['/Fotos', '/no-existe']), (error: unknown) => error instanceof AppError && error.code === 'NOT_FOUND');
  });

  it('se corta por tiempo, por número de elementos o al cancelar, y lo marca como incompleto', async () => {
    let clock = 0;
    const slow = await measureSize(h.dataRoot, ['/Fotos'], { budgetMs: 2, now: () => clock++ });
    assert.equal(slow.complete, false);
    const capped = await measureSize(h.dataRoot, ['/Fotos'], { maxEntries: 2 });
    assert.equal(capped.complete, false);
    assert.ok(capped.files + capped.folders <= 2);
    const cancelled = await measureSize(h.dataRoot, ['/Fotos'], { signal: AbortSignal.abort() });
    assert.deepEqual(cancelled, { bytes: 0, files: 0, folders: 0, complete: false });
  });
});
