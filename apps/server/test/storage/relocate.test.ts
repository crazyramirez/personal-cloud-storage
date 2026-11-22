import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FavoriteStore } from '../../src/favorites/store.ts';
import { ShareStore } from '../../src/share/store.ts';
import type { FsOperations } from '../../src/storage/operations.ts';
import { relocatePaths } from '../../src/storage/relocate.ts';
import { chunksOf, createHarness, insertUser, type Harness } from '../support/harness.ts';

describe('rutas guardadas que siguen al renombrar o mover', () => {
  let h: Harness;
  let ops: FsOperations;
  let store: ShareStore;
  let userId: number;

  const share = (p: string, kind: 'file' | 'dir' = 'dir'): string =>
    store.create({ path: p, kind, name: path.posix.basename(p), userId, expiresInDays: 7, passwordHash: null, maxDownloads: null }, new Date()).share.id;
  const sharePath = (id: string): string | undefined => store.get(id)?.path;

  beforeEach(async () => {
    h = await createHarness();
    userId = insertUser(h.db);
    store = new ShareStore(h.db);
    ops = h.operations({ relocated: (from, to) => relocatePaths(h.db, from, to) });
    await mkdir(path.join(h.dataRoot, 'Fotos', 'Viaje'), { recursive: true });
    await mkdir(path.join(h.dataRoot, 'Destino'));
    await writeFile(path.join(h.dataRoot, 'Fotos', 'Viaje', 'playa.jpg'), 'jpg');
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('al renombrar una carpeta, sus enlaces y los de dentro apuntan al nombre nuevo', async () => {
    const folder = share('/Fotos');
    const inner = share('/Fotos/Viaje');
    const file = share('/Fotos/Viaje/playa.jpg', 'file');
    const similar = share('/FotosViejas'); // mismo prefijo de texto, otra carpeta: no se toca
    await ops.rename('/Fotos', 'Álbum');
    assert.equal(sharePath(folder), '/Álbum');
    assert.equal(sharePath(inner), '/Álbum/Viaje');
    assert.equal(sharePath(file), '/Álbum/Viaje/playa.jpg');
    assert.equal(sharePath(similar), '/FotosViejas');
  });

  it('cambiar solo mayúsculas (dos pasos en exFAT) también actualiza los enlaces', async () => {
    const id = share('/Fotos/Viaje');
    await ops.rename('/Fotos', 'FOTOS');
    assert.equal(sharePath(id), '/FOTOS/Viaje');
  });

  it('al mover, los enlaces siguen al elemento', async () => {
    const id = share('/Fotos/Viaje/playa.jpg', 'file');
    await ops.move(['/Fotos/Viaje'], '/Destino');
    assert.equal(sharePath(id), '/Destino/Viaje/playa.jpg');
  });

  it('una subida en curso a la carpeta renombrada termina en la carpeta nueva', async () => {
    const uploads = h.uploads();
    const data = randomBytes(1000);
    const { id } = await uploads.create(userId, { path: '/Fotos/Viaje', name: 'nueva.jpg', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data, 256));
    await ops.rename('/Fotos', 'Álbum');
    const done = await uploads.complete(userId, id);
    assert.equal(done.path, '/Álbum/Viaje/nueva.jpg');
    assert.deepEqual(await readFile(path.join(h.dataRoot, 'Álbum', 'Viaje', 'nueva.jpg')), data);
  });

  it('los favoritos siguen al elemento; uno antiguo en la ruta de destino cede su sitio', async () => {
    const favorites = new FavoriteStore(h.db);
    const other = insertUser(h.db, 'luis', 'user');
    favorites.add(userId, [{ path: '/Fotos', kind: 'dir' }, { path: '/Fotos/Viaje/playa.jpg', kind: 'file' }, { path: '/Álbum', kind: 'dir' }, { path: '/FotosViejas', kind: 'dir' }], new Date());
    favorites.add(other, [{ path: '/Fotos/Viaje', kind: 'dir' }], new Date());
    // «/Álbum» ya no existe (se eliminó) pero sigue en favoritos: el rename lo ocupa.
    await ops.rename('/Fotos', 'Álbum');
    assert.deepEqual(favorites.list(userId).map((row) => row.path).sort(), ['/FotosViejas', '/Álbum', '/Álbum/Viaje/playa.jpg']);
    assert.equal(favorites.list(userId).find((row) => row.path === '/Álbum')?.kind, 'dir');
    assert.deepEqual(favorites.list(other).map((row) => row.path), ['/Álbum/Viaje'], 'los de cada usuario');
    await ops.move(['/Álbum/Viaje/playa.jpg'], '/Destino');
    assert.ok(favorites.list(userId).some((row) => row.path === '/Destino/playa.jpg'));
  });

  it('las subidas ya terminadas no cambian su ruta final', async () => {
    const uploads = h.uploads();
    const data = randomBytes(100);
    const { id } = await uploads.create(userId, { path: '/Fotos', name: 'hecha.jpg', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data, 100));
    await uploads.complete(userId, id);
    await ops.rename('/Fotos', 'Álbum');
    const row = h.db.prepare('SELECT dir_path, final_path FROM uploads WHERE id = ?').get(id) as { dir_path: string; final_path: string };
    assert.deepEqual({ ...row }, { dir_path: '/Fotos', final_path: '/Fotos/hecha.jpg' });
  });
});
