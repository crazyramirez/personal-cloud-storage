import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parseAuditMessage, SMB_RECENT_KEEP, SmbRecentStore } from '../../src/smb/recent.ts';
import { createHarness, type Harness } from '../support/harness.ts';

const ROOT = '/srv/pcloud/data';
const SHARE = `${ROOT}/DEV_Backup_Studio`;
const line = (...fields: string[]): string => [SHARE, ...fields].join('|');

describe('líneas de full_audit de la carpeta de red (ADR-0024)', () => {
  it('carpeta creada → su ruta en la nube', () => {
    assert.deepEqual(parseAuditMessage(line('mkdirat', 'ok', `${SHARE}/PC/Fotos`), ROOT), { kind: 'write', path: '/DEV_Backup_Studio/PC/Fotos' });
  });

  it('archivo creado o reescrito → su ruta; abrirlo solo para leer, no', () => {
    const file = `${SHARE}/PC/informe.pdf`;
    assert.deepEqual(parseAuditMessage(line('create_file', 'ok', '0x12019f', 'file', 'create', file), ROOT), { kind: 'write', path: '/DEV_Backup_Studio/PC/informe.pdf' });
    assert.deepEqual(parseAuditMessage(line('create_file', 'ok', '0x12019f', 'file', 'overwrite_if', file), ROOT)?.path, '/DEV_Backup_Studio/PC/informe.pdf');
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x120089', 'file', 'open', file), ROOT), null, 'lectura');
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x120089', 'file', 'open_if', file), ROOT), null, 'open_if sin permiso de escritura');
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x120116', 'file', 'open_if', file), ROOT)?.path, '/DEV_Backup_Studio/PC/informe.pdf', 'open_if para escribir');
  });

  it('listar una carpeta (create_file de tipo dir sin crearla) no cuenta', () => {
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x100081', 'dir', 'open', `${SHARE}/PC`), ROOT), null);
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x100081', 'dir', 'open_if', `${SHARE}/PC`), ROOT), null);
  });

  it('renombrar → el destino (y el origen para retirarlo)', () => {
    assert.deepEqual(parseAuditMessage(line('renameat', 'ok', `${SHARE}/PC/a.tmp`, `${SHARE}/PC/a.docx`), ROOT), {
      kind: 'rename',
      from: '',
      path: '/DEV_Backup_Studio/PC/a.docx',
    });
    assert.deepEqual(parseAuditMessage(line('renameat', 'ok', `${SHARE}/PC/viejo`, `${SHARE}/PC/nuevo`), ROOT), {
      kind: 'rename',
      from: '/DEV_Backup_Studio/PC/viejo',
      path: '/DEV_Backup_Studio/PC/nuevo',
    });
  });

  it('rutas relativas al prefijo, fallos, temporales y rutas fuera de la nube se ignoran o resuelven', () => {
    assert.equal(parseAuditMessage(line('mkdirat', 'ok', 'PC/Música'), ROOT)?.path, '/DEV_Backup_Studio/PC/Música');
    assert.equal(parseAuditMessage(line('mkdirat', 'fail (NT_STATUS_OBJECT_NAME_COLLISION)', `${SHARE}/PC`), ROOT), null);
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x12019f', 'file', 'create', `${SHARE}/PC/~$informe.docx`), ROOT), null);
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x12019f', 'file', 'create', `${SHARE}/PC/Thumbs.db`), ROOT), null);
    assert.equal(parseAuditMessage(line('create_file', 'ok', '0x12019f', 'file', 'create', `${SHARE}/PC/a.txt:Zone.Identifier`), ROOT), null);
    assert.equal(parseAuditMessage(line('mkdirat', 'ok', '/etc/samba'), ROOT), null);
    assert.equal(parseAuditMessage(line('mkdirat', 'ok', `${ROOT}/.pcloud/staging/x`), ROOT), null);
    assert.equal(parseAuditMessage(line('mkdirat', 'ok', `${SHARE}/../../x`), ROOT), null);
    assert.equal(parseAuditMessage('texto cualquiera', ROOT), null);
    assert.equal(parseAuditMessage(line('unlinkat', 'ok', `${SHARE}/PC/a`), ROOT), null);
  });

  it('raíz de datos «.» (el disco entero es la nube)', () => {
    assert.equal(parseAuditMessage('/srv/pcloud/Copias|mkdirat|ok|/srv/pcloud/Copias/PC', '/srv/pcloud')?.path, '/Copias/PC');
  });
});

describe('SmbRecentStore', () => {
  let h: Harness;
  let store: SmbRecentStore;
  beforeEach(async () => {
    h = await createHarness();
    store = new SmbRecentStore(h.db);
  });
  afterEach(async () => {
    await h.dispose();
  });

  it('guarda lo último primero, sin repetir rutas, y el cursor del diario', () => {
    store.record(
      [
        { event: { kind: 'write', path: '/C/a' }, at: '2026-11-19T10:00:00.000Z' },
        { event: { kind: 'write', path: '/C/b' }, at: '2026-11-19T10:00:01.000Z' },
        { event: { kind: 'write', path: '/C/a' }, at: '2026-11-19T10:00:02.000Z' },
      ],
      's=1',
    );
    assert.deepEqual(store.list(10).map((row) => row.path), ['/C/a', '/C/b']);
    assert.equal(store.cursor(), 's=1');
    store.forgetCursor();
    assert.equal(store.cursor(), null);
  });

  it('un renombrado retira el nombre antiguo', () => {
    store.record([{ event: { kind: 'write', path: '/C/viejo' }, at: '2026-11-19T10:00:00.000Z' }], null);
    store.record([{ event: { kind: 'rename', from: '/C/viejo', path: '/C/nuevo' }, at: '2026-11-19T10:00:01.000Z' }], null);
    assert.deepEqual(store.list(10).map((row) => row.path), ['/C/nuevo']);
  });

  it(`se queda solo con las ${SMB_RECENT_KEEP} más recientes`, () => {
    const base = Date.parse('2026-11-19T10:00:00.000Z');
    const events = Array.from({ length: SMB_RECENT_KEEP + 50 }, (_, i) => ({
      event: { kind: 'write' as const, path: `/C/${i}` },
      at: new Date(base + i * 1000).toISOString(),
    }));
    store.record(events, null);
    const rows = store.list(SMB_RECENT_KEEP + 100);
    assert.equal(rows.length, SMB_RECENT_KEEP);
    assert.equal(rows[0]?.path, `/C/${SMB_RECENT_KEEP + 49}`);
  });
});
