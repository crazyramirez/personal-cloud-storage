import assert from 'node:assert/strict';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AppError } from '../../src/errors.ts';
import { createFolder, listDirectory, resolveDownload } from '../../src/storage/files.ts';
import { checkNewName, foldKey, portabilityIssue, uniqueName } from '../../src/storage/names.ts';
import { formatClientPath, parseClientPath, resolveInside } from '../../src/storage/paths.ts';
import { createHarness, type Harness } from '../support/harness.ts';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError, String(error));
    return error.code;
  }
  assert.fail('se esperaba un AppError');
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof AppError && error.code === code);
}

describe('política de nombres portables (spec §3.1)', () => {
  it('acepta nombres normales, con acentos y emoji', () => {
    for (const name of ['Informe.pdf', 'Año 2026', 'Fotografías', 'vacaciones 🌴.jpg', '.gitignore', 'a.b.c', 'CONSOLA.txt', 'COM10']) {
      assert.equal(checkNewName(name), name.normalize('NFC'));
    }
  });

  it('normaliza a NFC', () => {
    const nfd = 'Fotografías';
    assert.equal(checkNewName(nfd), 'Fotografías');
  });

  const invalid: Array<[string, string]> = [
    ['barra invertida', 'a\\b'], ['barra', 'a/b'], ['dos puntos', 'Acta 03:11.docx'], ['asterisco', 'a*b'],
    ['interrogación', '¿qué?'], ['comillas', 'a"b'], ['menor', 'a<b'], ['mayor', 'a>b'], ['tubería', 'a|b'],
    ['carácter de control', 'a\u0007b'], ['salto de línea', 'a\nb'], ['termina en punto', 'informe.'],
    ['termina en espacio', 'informe '], ['vacío', ''], ['punto', '.'], ['dos puntos seguidos', '..'],
    ['CON', 'CON'], ['nul con extensión', 'nul.txt'], ['COM1', 'com1'], ['LPT9.log', 'LPT9.log'], ['AUX', 'Aux'],
    ['demasiado largo', 'x'.repeat(256)],
  ];
  for (const [label, name] of invalid) {
    it(`rechaza ${label}`, () => {
      assert.equal(codeOf(() => checkNewName(name)), 'INVALID_NAME');
      assert.notEqual(portabilityIssue(name), null);
    });
  }

  it('al crear rechaza además los nombres que empiezan por espacio (válidos en Windows, pero fuente de errores)', () => {
    assert.equal(codeOf(() => checkNewName(' informe')), 'INVALID_NAME');
    assert.equal(portabilityIssue(' informe'), null, 'un nombre existente así sí es portable: no se marca');
  });

  it('detecta colisiones por mayúsculas y por normalización Unicode', () => {
    assert.equal(foldKey('Informe.PDF'), foldKey('informe.pdf'));
    assert.equal(foldKey('Fotografías'), foldKey('Fotografías'));
    assert.notEqual(foldKey('a'), foldKey('b'));
  });

  it('uniqueName nunca devuelve un nombre ocupado', () => {
    const taken = new Set(['INFORME.PDF', 'INFORME (2).PDF', 'NOTAS'].map(foldKey));
    assert.equal(uniqueName('informe.pdf', taken), 'informe (3).pdf');
    assert.equal(uniqueName('Notas', taken), 'Notas (2)');
    assert.equal(uniqueName('libre.txt', taken), 'libre.txt');
    assert.equal(uniqueName('.config', new Set([foldKey('.config')])), '.config (2)');
  });
});

describe('rutas del cliente (spec §7.1, prueba 12)', () => {
  it('interpreta rutas relativas a la raíz de datos', () => {
    assert.deepEqual(parseClientPath('/'), []);
    assert.deepEqual(parseClientPath(''), []);
    assert.deepEqual(parseClientPath('/Proyectos/Web/'), ['Proyectos', 'Web']);
    assert.equal(formatClientPath(['Proyectos', 'Web']), '/Proyectos/Web');
    assert.equal(formatClientPath([]), '/');
  });

  for (const attack of ['/../etc/passwd', '/a/../../b', '/a/./b', '/a//b', '/a/..', '..', '/a\\..\\b', '/a/\u0000/b', `/${'x'.repeat(300)}`]) {
    it(`rechaza ${JSON.stringify(attack).slice(0, 40)}`, () => {
      assert.equal(codeOf(() => parseClientPath(attack)), 'INVALID_PATH');
    });
  }

  it('los intentos codificados llegan como texto literal y no escapan', () => {
    // El servidor web ya decodifica una vez: «%2e%2e» decodificado es «..» (rechazado arriba);
    // una doble codificación llega como el nombre literal «%2e%2e», que simplemente no existe.
    assert.deepEqual(parseClientPath('/%2e%2e/etc'), ['%2e%2e', 'etc']);
  });
});

describe('explorador sobre un volumen temporal', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('resolveInside no encuentra lo que está fuera de la raíz ni lo que no existe', async () => {
    await writeFile(path.join(h.root, 'secreto.txt'), 'fuera de data/');
    await rejectsWith(resolveInside(h.dataRoot, ['secreto.txt'], 'file'), 'NOT_FOUND');
    await rejectsWith(resolveInside(h.dataRoot, ['no', 'existe'], 'dir'), 'NOT_FOUND');
    await mkdir(path.join(h.dataRoot, 'Docs'));
    await writeFile(path.join(h.dataRoot, 'Docs', 'a.txt'), 'hola');
    await rejectsWith(resolveInside(h.dataRoot, ['Docs', 'a.txt'], 'dir'), 'NOT_FOUND');
    await rejectsWith(resolveInside(h.dataRoot, ['Docs', 'a.txt', 'x'], 'file'), 'NOT_FOUND');
    assert.equal((await resolveInside(h.dataRoot, ['Docs', 'a.txt'], 'file')).stats.size, 4);
  });

  it('no sigue enlaces simbólicos', async (t) => {
    await mkdir(path.join(h.root, 'fuera'));
    await writeFile(path.join(h.root, 'fuera', 'secreto.txt'), 'x');
    try {
      await symlink(path.join(h.root, 'fuera'), path.join(h.dataRoot, 'enlace'), 'junction');
    } catch {
      return t.skip('este sistema no permite crear enlaces simbólicos');
    }
    await rejectsWith(resolveInside(h.dataRoot, ['enlace', 'secreto.txt'], 'file'), 'INVALID_PATH');
    const listing = await listDirectory(h.dataRoot, '/');
    assert.ok(!listing.entries.some((entry) => entry.name === 'enlace'), 'los enlaces no se listan');
  });

  it('lista carpetas primero, en orden natural, con tamaños y fechas', async () => {
    await mkdir(path.join(h.dataRoot, 'Zeta'));
    await mkdir(path.join(h.dataRoot, 'alfa'));
    await writeFile(path.join(h.dataRoot, 'foto10.jpg'), 'x'.repeat(10));
    await writeFile(path.join(h.dataRoot, 'foto2.jpg'), 'x'.repeat(2));
    await writeFile(path.join(h.dataRoot, 'Árbol.txt'), '');
    const listing = await listDirectory(h.dataRoot, '/');
    assert.deepEqual(listing.entries.map((entry) => entry.name), ['alfa', 'Zeta', 'Árbol.txt', 'foto2.jpg', 'foto10.jpg']);
    assert.deepEqual(listing.entries.map((entry) => entry.type), ['dir', 'dir', 'file', 'file', 'file']);
    assert.equal(listing.entries[4]?.size, 10);
    assert.equal(listing.total, 5);
    assert.equal(listing.nextCursor, null);
    assert.equal(listing.path, '/');
    assert.match(listing.entries[0]?.mtime ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('pagina sin enviar toda la carpeta de una vez', async () => {
    for (let i = 0; i < 25; i++) await writeFile(path.join(h.dataRoot, `f${String(i).padStart(2, '0')}.txt`), '');
    const first = await listDirectory(h.dataRoot, '/', { limit: 10 });
    assert.equal(first.entries.length, 10);
    assert.equal(first.total, 25);
    assert.equal(first.nextCursor, '10');
    const second = await listDirectory(h.dataRoot, '/', { limit: 10, cursor: first.nextCursor ?? undefined });
    assert.equal(second.entries[0]?.name, 'f10.txt');
    const last = await listDirectory(h.dataRoot, '/', { limit: 10, cursor: '20' });
    assert.equal(last.entries.length, 5);
    assert.equal(last.nextCursor, null);
  });

  it('marca como no portables los nombres que no valen en Windows, sin renombrarlos', async (t) => {
    // En NTFS «a:b» no falla: crea un flujo alternativo de datos en el fichero «a».
    if (process.platform === 'win32') return t.skip('Windows no puede crear nombres con «:»');
    try {
      await writeFile(path.join(h.dataRoot, 'Acta 03:11.txt'), '');
    } catch {
      return t.skip('este sistema de archivos no admite «:» en nombres');
    }
    const listing = await listDirectory(h.dataRoot, '/');
    const entry = listing.entries.find((item) => item.name === 'Acta 03:11.txt');
    assert.equal(entry?.portable, false);
    assert.match(entry?.issue ?? '', /Windows/);
    assert.deepEqual(await readdir(h.dataRoot), ['Acta 03:11.txt']);
  });

  it('crea carpetas con nombre portable y revalida antes de escribir', async () => {
    let revalidated = 0;
    const created = await createFolder(h.dataRoot, '/', 'Proyectos', async () => {
      revalidated += 1;
    });
    assert.deepEqual(created, { path: '/Proyectos', name: 'Proyectos' });
    assert.equal(revalidated, 1);
    const nested = await createFolder(h.dataRoot, '/Proyectos', 'Año 2026', async () => undefined);
    assert.equal(nested.path, '/Proyectos/Año 2026');
    assert.deepEqual(await readdir(path.join(h.dataRoot, 'Proyectos')), ['Año 2026']);
  });

  it('no crea carpetas con nombres inválidos, duplicados (también por mayúsculas) ni fuera de la raíz', async () => {
    const noop = async (): Promise<void> => undefined;
    await createFolder(h.dataRoot, '/', 'Docs', noop);
    await rejectsWith(createFolder(h.dataRoot, '/', 'docs', noop), 'CONFLICT');
    await rejectsWith(createFolder(h.dataRoot, '/', 'CON', noop), 'INVALID_NAME');
    await rejectsWith(createFolder(h.dataRoot, '/', 'a/b', noop), 'INVALID_NAME');
    await rejectsWith(createFolder(h.dataRoot, '/../', 'x', noop), 'INVALID_PATH');
    await rejectsWith(createFolder(h.dataRoot, '/no-existe', 'x', noop), 'NOT_FOUND');
    assert.deepEqual(await readdir(h.dataRoot), ['Docs']);
  });

  it('si el volumen cambia justo antes de escribir, no crea nada', async () => {
    await assert.rejects(
      createFolder(h.dataRoot, '/', 'Nueva', async () => {
        throw new Error('generación cambiada');
      }),
      /generación cambiada/,
    );
    assert.deepEqual(await readdir(h.dataRoot), []);
  });

  it('resolveDownload solo acepta archivos regulares dentro de la raíz', async () => {
    await mkdir(path.join(h.dataRoot, 'Docs'));
    await writeFile(path.join(h.dataRoot, 'Docs', 'a.txt'), 'hola');
    const target = await resolveDownload(h.dataRoot, '/Docs/a.txt');
    assert.equal(target.name, 'a.txt');
    assert.equal(target.size, 4);
    await rejectsWith(resolveDownload(h.dataRoot, '/Docs'), 'NOT_FOUND');
    await rejectsWith(resolveDownload(h.dataRoot, '/'), 'NOT_FOUND');
    await rejectsWith(resolveDownload(h.dataRoot, '/Docs/../../secreto'), 'INVALID_PATH');
  });
});
