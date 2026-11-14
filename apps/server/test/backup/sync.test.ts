import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  executePlan,
  listArchives,
  planSync,
  purgeExpiredArchives,
  runStamp,
  scanTree,
  SyncAbortedError,
  type ExecuteHooks,
  type Tree,
} from '../../src/backup/sync.ts';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/** Árbol como mapa ruta → sha256 (carpetas: «dir»). */
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

async function put(root: string, rel: string, content: string | Buffer, mtime?: Date): Promise<void> {
  const file = path.join(root, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  if (mtime !== undefined) await utimes(file, mtime, mtime);
}

const tree = (files: Record<string, [number, number]>, dirs: string[]): Tree => ({
  files: new Map(Object.entries(files).map(([rel, [size, mtimeMs]]) => [rel, { size, mtimeMs }])),
  dirs: new Set(dirs),
});

describe('planSync', () => {
  it('distingue nuevos, cambiados, iguales y sobrantes', () => {
    const source = tree({ 'a.txt': [1, 1000], 'b.txt': [2, 1000], 'f/c.txt': [3, 1000] }, ['f']);
    const target = tree({ 'a.txt': [1, 2500], 'b.txt': [9, 1000], 'old.txt': [4, 1000], 'g/x.txt': [5, 1000], 'g/h/y.txt': [6, 1000] }, ['g', 'g/h']);
    const plan = planSync(source, target);
    assert.deepEqual(plan.copy.map((item) => `${item.kind}:${item.rel}`), ['changed:b.txt', 'new:f/c.txt']);
    assert.deepEqual(plan.mkdirs, ['f']);
    assert.deepEqual(plan.archiveFiles, ['old.txt']);
    // Solo la carpeta más alta de la rama sobrante; sus archivos cuentan como retirados.
    assert.deepEqual(plan.archiveDirs, ['g']);
    assert.deepEqual(plan.summary, { newFiles: 1, changedFiles: 1, removedFiles: 3, unchangedFiles: 1, bytesToCopy: 5 });
  });

  it('tolera 2 s de diferencia en la fecha (precisión de exFAT y otros)', () => {
    const plan = planSync(tree({ 'a.txt': [1, 10_000] }, []), tree({ 'a.txt': [1, 11_900] }, []));
    assert.equal(plan.copy.length, 0);
  });

  it('archivo convertido en carpeta y al revés: aparta lo viejo antes de crear lo nuevo', () => {
    const source = tree({ 'x/inside.txt': [1, 1], y: [1, 1] }, ['x']);
    const target = tree({ x: [1, 1], 'y/inside.txt': [1, 1] }, ['y']);
    const plan = planSync(source, target);
    assert.deepEqual(plan.archiveFiles, ['x']);
    assert.deepEqual(plan.archiveDirs, ['y']);
    assert.deepEqual(plan.mkdirs, ['x']);
    assert.deepEqual(plan.copy.map((item) => item.rel).sort(), ['x/inside.txt', 'y']);
  });
});

describe('executePlan', () => {
  let base: string;
  let source: string;
  let mirror: string;
  let archive: string;
  let flushes: number;

  const hooks = (overrides: Partial<ExecuteHooks> = {}): ExecuteHooks => ({
    signal: new AbortController().signal,
    guard: async () => undefined,
    onProgress: () => undefined,
    flush: async () => {
      flushes += 1;
    },
    ...overrides,
  });

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), 'pcloud-backup-'));
    source = path.join(base, 'nube');
    mirror = path.join(base, 'copia', 'Personal Cloud Storage');
    archive = path.join(base, 'copia', '.pcloud-backup', 'archivo', '2026-11-14_10-00-00');
    flushes = 0;
    await mkdir(source, { recursive: true });
    await mkdir(mirror, { recursive: true });
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('deja la copia idéntica a la nube y aparta (no borra) lo sustituido y lo sobrante', async () => {
    const old = new Date('2025-01-01T00:00:00Z');
    await put(source, 'Fotos/playa.jpg', 'playa', old);
    await put(source, 'Docs/informe.pdf', 'informe v2');
    await put(source, 'igual.txt', 'igual', old);
    await put(mirror, 'igual.txt', 'igual', old);
    await put(mirror, 'Docs/informe.pdf', 'informe v1', old);
    await put(mirror, 'borrado.txt', 'ya no está en la nube');
    await put(mirror, 'Viejo/a.txt', 'carpeta entera borrada');
    // Temporal abandonado por una sincronización cortada: se limpia al escanear.
    await put(mirror, 'Docs/.pcloud-sync-0123456789abcdef.tmp', 'basura');

    const plan = planSync(await scanTree(source), await scanTree(mirror, { removeStaleTemps: true }));
    const result = await executePlan(plan, source, mirror, archive, hooks());

    assert.deepEqual(result.failed, []);
    assert.equal(result.filesCopied, 2);
    assert.deepEqual(await snapshot(mirror), await snapshot(source));
    assert.deepEqual(await snapshot(archive), {
      'Docs/': 'dir',
      'Docs/informe.pdf': sha('informe v1'),
      'Viejo/': 'dir',
      'Viejo/a.txt': sha('carpeta entera borrada'),
      'borrado.txt': sha('ya no está en la nube'),
    });
    // La fecha original se conserva: la próxima vez no se vuelve a copiar.
    assert.equal((await stat(path.join(mirror, 'Fotos/playa.jpg'))).mtimeMs, old.getTime());
    assert.equal(planSync(await scanTree(source), await scanTree(mirror)).copy.length, 0);
    assert.ok(flushes >= 1, 'se vacía la caché del disco antes de dar los archivos por buenos');
  });

  it('un archivo que cambia mientras se copia no se da por bueno (se copiará la próxima vez)', async () => {
    await put(source, 'grande.bin', Buffer.alloc(3 * 1024 * 1024, 1));
    await put(source, 'otro.txt', 'otro');
    const plan = planSync(await scanTree(source), await scanTree(mirror));
    let touched = false;
    const result = await executePlan(
      plan,
      source,
      mirror,
      archive,
      hooks({
        onProgress: ({ current, bytesDone }) => {
          if (current === 'grande.bin' && bytesDone > 0 && !touched) {
            touched = true;
            void appendFile(path.join(source, 'grande.bin'), 'más');
          }
        },
      }),
    );
    assert.deepEqual(result.failed, [{ rel: 'grande.bin', code: 'CHANGED_DURING_COPY' }]);
    assert.deepEqual(Object.keys(await snapshot(mirror)), ['otro.txt']);
  });

  it('cancelar a mitad no deja temporales ni archivos a medias', async () => {
    for (let i = 0; i < 5; i += 1) await put(source, `f${i}.bin`, Buffer.alloc(2 * 1024 * 1024, i));
    const plan = planSync(await scanTree(source), await scanTree(mirror));
    const controller = new AbortController();
    await assert.rejects(
      executePlan(
        plan,
        source,
        mirror,
        archive,
        hooks({
          signal: controller.signal,
          onProgress: ({ current }) => {
            if (current === 'f2.bin') controller.abort();
          },
        }),
      ),
      (error: unknown) => error instanceof SyncAbortedError && error.code === 'CANCELLED',
    );
    const left = Object.keys(await snapshot(mirror));
    assert.ok(left.every((name) => /^f\d\.bin$/.test(name)), `sin temporales: ${left.join(',')}`);
    // Lo que quedó está completo y es correcto; lo demás se copiará la próxima vez.
    for (const name of left) assert.equal((await stat(path.join(mirror, name))).size, 2 * 1024 * 1024);
  });

  it('si el disco de copia desaparece, para con DISK_REMOVED', async () => {
    await put(source, 'a.txt', 'a');
    const plan = planSync(await scanTree(source), await scanTree(mirror));
    await assert.rejects(
      executePlan(plan, source, mirror, archive, hooks({ guard: async () => { throw new SyncAbortedError('DISK_REMOVED'); } })),
      (error: unknown) => error instanceof SyncAbortedError && error.code === 'DISK_REMOVED',
    );
  });
});

describe('archivo de versiones', () => {
  it('borra solo las carpetas de fecha caducadas, de la más antigua a la más reciente', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'pcloud-archive-'));
    try {
      const now = new Date('2026-11-14T12:00:00Z');
      for (const days of [200, 100, 10]) {
        await put(base, `${runStamp(new Date(now.getTime() - days * 86_400_000))}/x.txt`, 'x');
      }
      await mkdir(path.join(base, 'no-es-una-fecha'));
      assert.equal(await purgeExpiredArchives(base, 90, now), 2);
      assert.deepEqual((await listArchives(base)).map((item) => item.name), [runStamp(new Date(now.getTime() - 10 * 86_400_000))]);
      assert.ok((await readdir(base)).includes('no-es-una-fecha'), 'lo que no reconoce no lo toca');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
