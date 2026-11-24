import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { NameIndex, parseIndex, scanInChildProcess, scanTree, SearchIndex, serializeIndex, type IndexData } from '../../src/storage/search-index.ts';
import { searchTokens, searchTree } from '../../src/storage/search.ts';
import { createHarness, type Harness } from '../support/harness.ts';

describe('índice de nombres para la búsqueda (ADR-0029)', () => {
  let h: Harness;

  before(async () => {
    h = await createHarness();
    const d = h.dataRoot;
    await mkdir(path.join(d, 'Fotos', 'Viaje 2026', 'Playa'), { recursive: true });
    await mkdir(path.join(d, 'Documentos', 'Canciones'), { recursive: true });
    await writeFile(path.join(d, 'Fotos', 'viaje-portada.jpg'), 'jpg!');
    await writeFile(path.join(d, 'Fotos', 'Viaje 2026', 'Playa', 'atardecer en la playa.jpg'), 'x');
    await writeFile(path.join(d, 'Documentos', 'Canciones', 'canción de verano.mp3'), 'mp3');
    await writeFile(path.join(d, 'Documentos', 'presupuesto viaje.pdf'), 'pdf');
  });

  after(async () => {
    await h.dispose();
  });

  const find = (index: NameIndex, dir: string[], q: string): string[] | null => index.find(dir, searchTokens(q))?.map((segments) => `/${segments.join('/')}`) ?? null;

  it('recorre todo sin la carpeta interna y se guarda y se lee igual', async () => {
    const data = await scanTree(h.dataRoot, { now: () => new Date('2026-11-24T10:00:00.000Z') });
    assert.equal(data.names.length, 9);
    assert.ok(!data.names.some((name) => name.startsWith('.pcloud')));
    const again = parseIndex(serializeIndex(data));
    assert.deepEqual(again, data);
    assert.equal(parseIndex('{"format":99}'), null, 'otra versión: se ignora');
    assert.equal(parseIndex('no es json'), null);
    assert.equal(parseIndex(JSON.stringify({ format: 1, builtAt: 'x', names: ['a'], parents: [3], kinds: [0] })), null, 'incoherente');
  });

  it('busca en todo el árbol o dentro de una carpeta, sin mayúsculas ni acentos, lo cercano primero', async () => {
    const index = new NameIndex(await scanTree(h.dataRoot));
    assert.deepEqual(find(index, [], 'VIAJE'), ['/Fotos/Viaje 2026', '/Documentos/presupuesto viaje.pdf', '/Fotos/viaje-portada.jpg']);
    assert.deepEqual(find(index, ['Fotos'], 'viaje'), ['/Fotos/Viaje 2026', '/Fotos/viaje-portada.jpg']);
    assert.deepEqual(find(index, [], 'cancion'), ['/Documentos/Canciones', '/Documentos/Canciones/canción de verano.mp3']);
    assert.deepEqual(find(index, [], 'playa atardecer'), ['/Fotos/Viaje 2026/Playa/atardecer en la playa.jpg']);
    assert.deepEqual(find(index, ['Fotos', 'Viaje 2026'], 'viaje'), [], 'la propia carpeta no cuenta');
    assert.equal(find(index, ['No-indexada'], 'x'), null, 'carpeta que no está en el índice');
  });

  it('con índice: no devuelve lo que ya no existe y sí lo creado desde la web después', async () => {
    const index = new NameIndex(await scanTree(h.dataRoot));
    await rm(path.join(h.dataRoot, 'Fotos', 'viaje-portada.jpg'));
    await mkdir(path.join(h.dataRoot, 'Nueva', 'Sub'), { recursive: true });
    await writeFile(path.join(h.dataRoot, 'Nueva', 'Sub', 'viaje nuevo.txt'), 'n');
    // El recorrido en directo no llega a nada (presupuesto 0): solo cuenta el índice + lo añadido.
    const source = { state: 'ready' as const, builtAt: index.builtAt, index, added: new Set(['/Nueva/Sub/viaje nuevo.txt']) };
    const result = await searchTree(h.dataRoot, '/', 'viaje', { index: source, budgetMs: 0 });
    assert.deepEqual(result.results.map((item) => item.path).sort(), ['/Documentos/presupuesto viaje.pdf', '/Fotos/Viaje 2026', '/Nueva/Sub/viaje nuevo.txt']);
    assert.equal(result.truncated, null, 'el índice cubre todo');
    assert.deepEqual(result.index, { state: 'ready', builtAt: index.builtAt });
    // Una carpeta creada después del índice: se busca en directo.
    const inNew = await searchTree(h.dataRoot, '/Nueva', 'viaje', { index: { ...source, added: new Set() } });
    assert.deepEqual(inNew.results.map((item) => item.path), ['/Nueva/Sub/viaje nuevo.txt']);
    await writeFile(path.join(h.dataRoot, 'Fotos', 'viaje-portada.jpg'), 'jpg!');
  });

  it('un candidato del índice que ahora es un enlace o sale del volumen no se muestra', async () => {
    const data: IndexData = { builtAt: '2026-11-24T10:00:00.000Z', names: ['..', 'viaje.txt'], parents: [-1, 0], kinds: [1, 0] };
    const index = new NameIndex(data);
    const result = await searchTree(h.dataRoot, '/', 'viaje', { index: { state: 'ready', builtAt: data.builtAt, index, added: new Set() }, budgetMs: 0 });
    assert.ok(!result.results.some((item) => item.path.includes('..')));
  });

  it('servicio: genera, guarda en la caché del disco, recarga al arrancar y recuerda lo cambiado', async () => {
    let scans = 0;
    const scanner = async (root: string): Promise<IndexData> => {
      scans += 1;
      return scanTree(root);
    };
    const service = new SearchIndex({ gate: h.gate, scanner, startDelayMs: 0, settleMs: 60_000 });
    assert.equal(service.state, 'none');
    await service.tick();
    assert.equal(scans, 1);
    assert.equal(service.state, 'ready');
    const saved = await readFile(path.join(h.root, '.pcloud', 'cache', 'search', 'index-v1.json'), 'utf8');
    assert.ok(parseIndex(saved) !== null, 'guardado en .pcloud/cache del disco de datos');

    // Otro arranque: carga lo guardado y no vuelve a recorrer (es reciente).
    let again = 0;
    const second = new SearchIndex({ gate: h.gate, scanner: async () => (again++, scanTree(h.dataRoot)) });
    await second.tick();
    assert.equal(again, 0);
    assert.equal(second.state, 'ready');

    // Cambios desde la web: se recuerdan hasta el siguiente recorrido.
    second.touched(['/Fotos/nueva.jpg', '../fuera']);
    assert.deepEqual([...second.added], ['/Fotos/nueva.jpg']);
    await second.rebuild();
    assert.equal(again, 1);
    assert.deepEqual([...second.added], []);
    second.stop();
    service.stop();
  });

  it('servicio: sin disco no recorre ni guarda nada; si el disco cambia durante el recorrido, se descarta', async () => {
    let scans = 0;
    const service = new SearchIndex({
      gate: h.gate,
      scanner: async (root) => {
        scans += 1;
        h.gate.disconnect(); // el disco desaparece a mitad
        return scanTree(root);
      },
    });
    h.gate.disconnect();
    await service.tick();
    assert.equal(scans, 0, 'sin disco no se intenta');
    h.gate.reconnect();
    await rm(path.join(h.root, '.pcloud', 'cache', 'search'), { recursive: true, force: true });
    await service.rebuild();
    assert.equal(scans, 1);
    assert.equal(service.state, 'none', 'resultado descartado');
    h.gate.reconnect();
    service.stop();
  });

  it('el proceso aparte de verdad: recorre y devuelve el mismo índice', async () => {
    const data = await scanInChildProcess(h.dataRoot, new AbortController().signal);
    const direct = await scanTree(h.dataRoot);
    assert.deepEqual([...data.names].sort(), [...direct.names].sort());
  });
});
