import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError } from '../../src/errors.ts';
import { StorageUnavailableError } from '../../src/storage/storage-guardian.ts';
import { chunksOf, createHarness, insertUser, type Harness } from '../support/harness.ts';

const KiB = 1024;

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `se esperaba AppError ${code}, llegó ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`se esperaba AppError ${code}`);
}

function confirmedOffset(h: Harness, id: string): number {
  return Number(h.db.prepare('SELECT confirmed_offset FROM uploads WHERE id = ?').get(id)?.['confirmed_offset']);
}

function stateOf(h: Harness, id: string): string {
  return String(h.db.prepare('SELECT state FROM uploads WHERE id = ?').get(id)?.['state']);
}

describe('subidas reanudables (ADR-0010)', () => {
  let h: Harness;
  let userId: number;
  beforeEach(async () => {
    h = await createHarness();
    userId = insertUser(h.db);
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('sube un archivo por bloques, lo confirma y lo deja en su destino', async () => {
    const uploads = h.uploads();
    const data = randomBytes(300 * KiB);
    const created = await uploads.create(userId, { path: '/', name: 'vídeo.bin', size: data.length });
    assert.equal(created.offset, 0);
    assert.deepEqual(await readdir(h.stagingDir), [`${created.id}.part`], 'el temporal vive en el HDD, en .pcloud/staging');
    assert.deepEqual(await readdir(h.dataRoot), [], 'nada visible hasta completar');

    let offset = 0;
    for (const size of [100 * KiB, 100 * KiB, 100 * KiB]) {
      offset = await uploads.append(userId, created.id, offset, chunksOf(data.subarray(offset, offset + size), 16 * KiB));
    }
    assert.equal(offset, data.length);
    const done = await uploads.complete(userId, created.id);
    assert.deepEqual(done, { path: '/vídeo.bin', name: 'vídeo.bin', size: data.length });
    assert.deepEqual(await readFile(path.join(h.dataRoot, 'vídeo.bin')), data);
    assert.deepEqual(await readdir(h.stagingDir), []);
    assert.equal(stateOf(h, created.id), 'completed');
  });

  it('completar es idempotente (reintento tras un timeout, spec §15.15)', async () => {
    const uploads = h.uploads();
    const data = randomBytes(10 * KiB);
    const { id } = await uploads.create(userId, { path: '/', name: 'a.bin', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data, 4 * KiB));
    const first = await uploads.complete(userId, id);
    const second = await uploads.complete(userId, id);
    assert.deepEqual(second, first);
    assert.deepEqual(await readdir(h.dataRoot), ['a.bin']);
  });

  it('solo confirma en la base lo sincronizado en un punto de control', async () => {
    const uploads = h.uploads({ checkpointBytes: 128 * KiB });
    const data = randomBytes(400 * KiB);
    const { id } = await uploads.create(userId, { path: '/', name: 'b.bin', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data.subarray(0, 100 * KiB), 32 * KiB));
    assert.equal(confirmedOffset(h, id), 0, '100 KiB recibidos pero sin fsync: aún no confirmados');
    await uploads.append(userId, id, 100 * KiB, chunksOf(data.subarray(100 * KiB, 200 * KiB), 32 * KiB));
    assert.equal(confirmedOffset(h, id), 200 * KiB, 'superado el punto de control: confirmado tras fsync');
  });

  it('desconexión a mitad de subida: retrocede al último offset confirmado y termina íntegra (spec §15.2)', async () => {
    const uploads = h.uploads({ checkpointBytes: 128 * KiB });
    const data = randomBytes(500 * KiB);
    const { id } = await uploads.create(userId, { path: '/', name: 'c.bin', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data.subarray(0, 200 * KiB), 64 * KiB)); // confirmado: 200 KiB
    await uploads.append(userId, id, 200 * KiB, chunksOf(data.subarray(200 * KiB, 260 * KiB), 64 * KiB)); // sin confirmar

    h.gate.disconnect();
    await assert.rejects(uploads.append(userId, id, 260 * KiB, chunksOf(data.subarray(260 * KiB), 64 * KiB)), StorageUnavailableError);
    await assert.rejects(uploads.complete(userId, id), StorageUnavailableError);
    assert.deepEqual(await readdir(h.dataRoot), [], 'ninguna escritura visible durante la desconexión');

    h.gate.reconnect();
    const status = await uploads.status(userId, id);
    assert.equal(status.offset, 200 * KiB, 'tras reconectar solo cuenta lo confirmado con fsync');
    const mismatch = await rejectsWith(uploads.append(userId, id, 260 * KiB, chunksOf(data.subarray(260 * KiB), 64 * KiB)), 'OFFSET_MISMATCH');
    assert.equal(mismatch.details?.['offset'], 200 * KiB);
    assert.equal((await stat(path.join(h.stagingDir, `${id}.part`))).size, 200 * KiB, 'la cola sin confirmar se descarta');

    let offset = 200 * KiB;
    while (offset < data.length) {
      offset = await uploads.append(userId, id, offset, chunksOf(data.subarray(offset, offset + 100 * KiB), 64 * KiB));
    }
    await uploads.complete(userId, id);
    assert.deepEqual(await readFile(path.join(h.dataRoot, 'c.bin')), data, 'el archivo final es idéntico al original');
  });

  it('un reinicio del servidor conserva el offset confirmado (spec §15.7)', async () => {
    const data = randomBytes(300 * KiB);
    const before = h.uploads({ checkpointBytes: 100 * KiB });
    const { id } = await before.create(userId, { path: '/', name: 'd.bin', size: data.length });
    await before.append(userId, id, 0, chunksOf(data.subarray(0, 150 * KiB), 50 * KiB));

    const after = h.uploads({ checkpointBytes: 100 * KiB }); // proceso nuevo: sin estado en memoria
    assert.equal((await after.status(userId, id)).offset, 150 * KiB);
    await after.append(userId, id, 150 * KiB, chunksOf(data.subarray(150 * KiB), 50 * KiB));
    await after.complete(userId, id);
    assert.deepEqual(await readFile(path.join(h.dataRoot, 'd.bin')), data);
  });

  it('rechaza offsets incorrectos y bloques que superan el tamaño declarado', async () => {
    const uploads = h.uploads();
    const { id } = await uploads.create(userId, { path: '/', name: 'e.bin', size: 10 * KiB });
    await rejectsWith(uploads.append(userId, id, 5, chunksOf(randomBytes(KiB), KiB)), 'OFFSET_MISMATCH');
    await rejectsWith(uploads.append(userId, id, 0, chunksOf(randomBytes(11 * KiB), KiB)), 'PAYLOAD_TOO_LARGE');
    await rejectsWith(uploads.complete(userId, id), 'OFFSET_MISMATCH');
    assert.equal((await uploads.status(userId, id)).offset, 0, 'un bloque rechazado no cuenta');
  });

  it('no acepta más de maxChunkSize por petición', async () => {
    const uploads = h.uploads({ maxChunkSize: 64 * KiB });
    const { id } = await uploads.create(userId, { path: '/', name: 'f.bin', size: 500 * KiB });
    await rejectsWith(uploads.append(userId, id, 0, chunksOf(randomBytes(65 * KiB), 8 * KiB)), 'PAYLOAD_TOO_LARGE');
  });

  it('nunca sobrescribe: si el nombre existe (también por mayúsculas) guarda «nombre (2)»', async () => {
    const uploads = h.uploads();
    await writeFile(path.join(h.dataRoot, 'Informe.pdf'), 'original');
    const data = Buffer.from('nuevo contenido');
    const { id } = await uploads.create(userId, { path: '/', name: 'informe.pdf', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data, 4));
    const done = await uploads.complete(userId, id);
    assert.equal(done.name, 'informe (2).pdf');
    assert.equal(await readFile(path.join(h.dataRoot, 'Informe.pdf'), 'utf8'), 'original');
    assert.equal(await readFile(path.join(h.dataRoot, 'informe (2).pdf'), 'utf8'), 'nuevo contenido');
  });

  it('dos subidas simultáneas con el mismo nombre no se pisan', async () => {
    const uploads = h.uploads();
    const a = Buffer.from('contenido A');
    const b = Buffer.from('contenido B, distinto');
    const ua = await uploads.create(userId, { path: '/', name: 'mismo.txt', size: a.length });
    const ub = await uploads.create(userId, { path: '/', name: 'mismo.txt', size: b.length });
    await uploads.append(userId, ua.id, 0, chunksOf(a, 4));
    await uploads.append(userId, ub.id, 0, chunksOf(b, 4));
    const [da, dbResult] = await Promise.all([uploads.complete(userId, ua.id), uploads.complete(userId, ub.id)]);
    assert.notEqual(da.name, dbResult.name);
    assert.deepEqual((await readdir(h.dataRoot)).sort(), ['mismo (2).txt', 'mismo.txt']);
    const contents = [await readFile(path.join(h.dataRoot, da.name), 'utf8'), await readFile(path.join(h.dataRoot, dbResult.name), 'utf8')];
    assert.deepEqual(contents, ['contenido A', 'contenido B, distinto']);
  });

  it('verifica el SHA-256 declarado y no publica un archivo corrupto', async () => {
    const uploads = h.uploads();
    const data = randomBytes(20 * KiB);
    const good = createHash('sha256').update(data).digest('hex');
    const ok = await uploads.create(userId, { path: '/', name: 'ok.bin', size: data.length, sha256: good });
    await uploads.append(userId, ok.id, 0, chunksOf(data, 8 * KiB));
    assert.equal((await uploads.complete(userId, ok.id)).name, 'ok.bin');

    const bad = await uploads.create(userId, { path: '/', name: 'mal.bin', size: data.length, sha256: '0'.repeat(64) });
    await uploads.append(userId, bad.id, 0, chunksOf(data, 8 * KiB));
    await rejectsWith(uploads.complete(userId, bad.id), 'CHECKSUM_MISMATCH');
    assert.deepEqual(await readdir(h.dataRoot), ['ok.bin']);
    assert.equal(stateOf(h, bad.id), 'failed');
  });

  it('admite archivos vacíos', async () => {
    const uploads = h.uploads();
    const { id } = await uploads.create(userId, { path: '/', name: 'vacío.txt', size: 0 });
    const done = await uploads.complete(userId, id);
    assert.equal(done.size, 0);
    assert.equal((await stat(path.join(h.dataRoot, 'vacío.txt'))).size, 0);
  });

  it('valida nombre y carpeta de destino antes de crear nada', async () => {
    const uploads = h.uploads();
    await rejectsWith(uploads.create(userId, { path: '/', name: 'CON', size: 1 }), 'INVALID_NAME');
    await rejectsWith(uploads.create(userId, { path: '/', name: 'a:b.txt', size: 1 }), 'INVALID_NAME');
    await rejectsWith(uploads.create(userId, { path: '/no-existe', name: 'a.txt', size: 1 }), 'NOT_FOUND');
    await rejectsWith(uploads.create(userId, { path: '/../fuera', name: 'a.txt', size: 1 }), 'INVALID_PATH');
    assert.deepEqual(await readdir(h.stagingDir), []);
  });

  it('respeta la reserva de espacio libre (507, spec §15.17)', async () => {
    const uploads = h.uploads({ minFreeBytes: Number.MAX_SAFE_INTEGER });
    await rejectsWith(uploads.create(userId, { path: '/', name: 'grande.bin', size: 1 }), 'INSUFFICIENT_STORAGE');
    assert.deepEqual(await readdir(h.stagingDir), []);
  });

  it('con el volumen no disponible no crea ni escribe nada (spec §15.1)', async () => {
    const uploads = h.uploads();
    h.gate.disconnect();
    await assert.rejects(uploads.create(userId, { path: '/', name: 'a.txt', size: 1 }), StorageUnavailableError);
    assert.deepEqual(await readdir(h.stagingDir), []);
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS n FROM uploads').get()?.['n']), 0);
  });

  it('una subida es privada de su usuario', async () => {
    const uploads = h.uploads();
    const other = insertUser(h.db, 'luis', 'user');
    const { id } = await uploads.create(userId, { path: '/', name: 'mío.txt', size: 4 });
    await rejectsWith(uploads.status(other, id), 'NOT_FOUND');
    await rejectsWith(uploads.append(other, id, 0, chunksOf(Buffer.from('hola'), 4)), 'NOT_FOUND');
    await rejectsWith(uploads.complete(other, id), 'NOT_FOUND');
  });

  it('cancelar elimina el temporal y no deja rastro en los datos', async () => {
    const uploads = h.uploads();
    const { id } = await uploads.create(userId, { path: '/', name: 'g.bin', size: 8 * KiB });
    await uploads.append(userId, id, 0, chunksOf(randomBytes(4 * KiB), KiB));
    await uploads.cancel(userId, id);
    assert.deepEqual(await readdir(h.stagingDir), []);
    assert.deepEqual(await readdir(h.dataRoot), []);
    assert.equal(stateOf(h, id), 'cancelled');
    await rejectsWith(uploads.append(userId, id, 4 * KiB, chunksOf(randomBytes(KiB), KiB)), 'CONFLICT');
  });

  it('limpia solo las subidas caducadas', async () => {
    let now = new Date('2026-11-14T10:00:00Z');
    const uploads = h.uploads({ ttlMs: 60_000, clock: () => now });
    const old = await uploads.create(userId, { path: '/', name: 'vieja.bin', size: 10 });
    now = new Date('2026-11-14T10:00:50Z');
    const recent = await uploads.create(userId, { path: '/', name: 'reciente.bin', size: 10 });
    now = new Date('2026-11-14T10:01:10Z');
    assert.equal(await uploads.cleanupExpired(), 1);
    assert.deepEqual(await readdir(h.stagingDir), [`${recent.id}.part`]);
    assert.equal(stateOf(h, old.id), 'cancelled');
  });

  describe('recuperación tras un fallo durante el commit (spec §7.2.9)', () => {
    async function leaveCommitting(name: string, data: Buffer): Promise<string> {
      const uploads = h.uploads();
      const { id } = await uploads.create(userId, { path: '/', name, size: data.length });
      await uploads.append(userId, id, 0, chunksOf(data, 4 * KiB));
      h.db.prepare("UPDATE uploads SET state = 'committing', final_path = ? WHERE id = ?").run(`/${name}`, id);
      return id;
    }

    it('rehace el rename si se perdió y el temporal está completo', async () => {
      const data = randomBytes(12 * KiB);
      const id = await leaveCommitting('h.bin', data);
      await h.uploads().recover();
      assert.equal(stateOf(h, id), 'completed');
      assert.deepEqual(await readFile(path.join(h.dataRoot, 'h.bin')), data);
      assert.deepEqual(await readdir(h.stagingDir), []);
    });

    it('da por completada la subida si el rename sí llegó al disco', async () => {
      const data = randomBytes(12 * KiB);
      const id = await leaveCommitting('i.bin', data);
      const { rename } = await import('node:fs/promises');
      await rename(path.join(h.stagingDir, `${id}.part`), path.join(h.dataRoot, 'i.bin'));
      await h.uploads().recover();
      assert.equal(stateOf(h, id), 'completed');
    });

    it('ante un estado ambiguo no toca ningún fichero', async () => {
      const data = randomBytes(12 * KiB);
      const id = await leaveCommitting('j.bin', data);
      await writeFile(path.join(h.dataRoot, 'j.bin'), 'otro contenido con el mismo nombre');
      await h.uploads().recover();
      assert.equal(stateOf(h, id), 'failed');
      assert.equal(await readFile(path.join(h.dataRoot, 'j.bin'), 'utf8'), 'otro contenido con el mismo nombre');
      assert.deepEqual(await readFile(path.join(h.stagingDir, `${id}.part`)), data, 'el temporal íntegro se conserva');
    });
  });

  it('sube a una subcarpeta y revalida el lease justo antes del commit', async () => {
    const uploads = h.uploads();
    await mkdir(path.join(h.dataRoot, 'Proyectos'));
    const data = Buffer.from('plano');
    const { id } = await uploads.create(userId, { path: '/Proyectos', name: 'plano.txt', size: data.length });
    await uploads.append(userId, id, 0, chunksOf(data, 2));
    const before = h.gate.revalidations;
    const done = await uploads.complete(userId, id);
    assert.equal(done.path, '/Proyectos/plano.txt');
    assert.ok(h.gate.revalidations > before);
  });
});
