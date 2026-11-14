import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { crc32 } from 'node:zlib';
import { AppError } from '../../src/errors.ts';
import { planZip, streamZip } from '../../src/storage/zip.ts';
import { createHarness, type Harness } from '../support/harness.ts';

interface Parsed {
  readonly name: string;
  readonly data: Buffer;
  readonly crc: number;
}

/** Lector ZIP mínimo e independiente del escritor: recorre el directorio central (ZIP64). */
function parseZip(zip: Buffer): Parsed[] {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50, 'registro final');
  const locator = end - 20;
  assert.equal(zip.readUInt32LE(locator), 0x07064b50, 'localizador ZIP64');
  const z64 = Number(zip.readBigUInt64LE(locator + 8));
  assert.equal(zip.readUInt32LE(z64), 0x06064b50, 'registro final ZIP64');
  const count = Number(zip.readBigUInt64LE(z64 + 32));
  let cursor = Number(zip.readBigUInt64LE(z64 + 48));
  const out: Parsed[] = [];
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50, 'cabecera central');
    assert.equal(zip.readUInt16LE(cursor + 8) & 0x0800, 0x0800, 'nombres UTF-8');
    const crc = zip.readUInt32LE(cursor + 16);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const extra = cursor + 46 + nameLength;
    assert.equal(zip.readUInt16LE(extra), 0x0001);
    const size = Number(zip.readBigUInt64LE(extra + 4));
    const offset = Number(zip.readBigUInt64LE(extra + 20));
    assert.equal(zip.readUInt32LE(offset), 0x04034b50, `cabecera local de ${name}`);
    const localStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const content = zip.subarray(localStart, localStart + size);
    const descriptor = localStart + size;
    assert.equal(zip.readUInt32LE(descriptor), 0x08074b50, `descriptor de ${name}`);
    assert.equal(zip.readUInt32LE(descriptor + 4), crc);
    out.push({ name, data: Buffer.from(content), crc });
    cursor = extra + extraLength;
  }
  return out;
}

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

describe('ZIP en streaming', () => {
  let h: Harness;
  const big = randomBytes(3 * 1024 * 1024 + 17);

  beforeEach(async () => {
    h = await createHarness();
    await mkdir(path.join(h.dataRoot, 'Viaje', 'Días', 'vacío'), { recursive: true });
    await writeFile(path.join(h.dataRoot, 'Viaje', 'Días', 'ñandú 📷.jpg'), big);
    await writeFile(path.join(h.dataRoot, 'Viaje', 'notas.txt'), 'hola');
    await writeFile(path.join(h.dataRoot, 'Viaje', 'vacío.txt'), '');
    await writeFile(path.join(h.dataRoot, 'suelto.txt'), 'suelto');
  });

  afterEach(async () => {
    await h.dispose();
  });

  it('carpeta completa: tamaño anunciado exacto, CRC y contenido correctos, nombres UTF-8', async () => {
    const plan = await planZip(h.dataRoot, '/Viaje', null);
    assert.equal(plan.fileName, 'Viaje.zip');
    const zip = await collect(streamZip(plan));
    assert.equal(zip.length, plan.length, 'Content-Length exacto');
    const entries = parseZip(zip);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.deepEqual([...byName.keys()].sort(), ['Días/', 'Días/vacío/', 'Días/ñandú 📷.jpg', 'notas.txt', 'vacío.txt']);
    const photo = byName.get('Días/ñandú 📷.jpg');
    assert.ok(photo?.data.equals(big));
    assert.equal(photo?.crc, crc32(big) >>> 0);
    assert.equal(byName.get('notas.txt')?.data.toString(), 'hola');
    assert.equal(byName.get('vacío.txt')?.data.length, 0);
  });

  it('selección de elementos de una carpeta, con la raíz como origen', async () => {
    const plan = await planZip(h.dataRoot, '/', ['suelto.txt', 'Viaje']);
    assert.equal(plan.fileName, 'Archivos.zip');
    const names = parseZip(await collect(streamZip(plan))).map((entry) => entry.name);
    assert.ok(names.includes('suelto.txt'));
    assert.ok(names.includes('Viaje/'));
    assert.ok(names.includes('Viaje/Días/ñandú 📷.jpg'));
    assert.equal((await planZip(h.dataRoot, '/', ['suelto.txt'])).fileName, 'suelto.zip');
  });

  it('rechaza rutas fuera de la carpeta y elementos inexistentes', async () => {
    for (const names of [['../x'], ['Viaje/notas.txt'], ['no-existe']]) {
      await assert.rejects(planZip(h.dataRoot, '/', names), (error: unknown) => error instanceof AppError);
    }
  });
});
