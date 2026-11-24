import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { MediaInfo } from '../../src/media/media.ts';
import { buildGuestApp, type GuestMedia } from '../../src/share/guest-app.ts';
import { ShareStore } from '../../src/share/store.ts';
import { createHarness, insertUser, type Harness } from '../support/harness.ts';

/** Visores de mentira: dicen qué hay que convertir sin lanzar ffmpeg ni LibreOffice. */
function fakeMedia(infos: Record<string, Partial<MediaInfo>>, calls: string[]): GuestMedia {
  return {
    capabilities: { ffmpeg: true, office: true, hardwareVideo: false },
    resolve: async (clientPath: string) => ({ abs: clientPath, rel: clientPath, name: clientPath.split('/').pop() ?? '', size: 1, mtimeMs: 1, lease: {} as never }),
    info: async (file) => ({ duration: 10, container: null, video: null, audio: null, playback: 'direct', directType: null, ...infos[file.name] }) as MediaInfo,
    image: async (file) => (calls.push(`image ${file.rel}`), { buffer: Buffer.from('jpeg!'), size: 5, contentType: 'image/jpeg' }),
    office: async (file) => (calls.push(`office ${file.rel}`), { buffer: Buffer.from('%PDF-1.7'), size: 8, contentType: 'application/pdf' }),
    stream: async () => null, // siempre «ocupado»: no hace falta lanzar ffmpeg
  } as GuestMedia;
}

describe('ver en el navegador los enlaces compartidos (ADR-0031)', () => {
  let h: Harness;
  let store: ShareStore;
  let plain: FastifyInstance;
  let full: FastifyInstance;
  let userId = 0;
  const calls: string[] = [];

  before(async () => {
    h = await createHarness();
    const d = path.join(h.dataRoot, 'Viaje');
    await mkdir(path.join(d, 'Sub'), { recursive: true });
    await writeFile(path.join(d, 'a-foto.jpg'), Buffer.from('ffd8ffe0', 'hex'));
    await writeFile(path.join(d, 'b-movil.heic'), 'heic');
    await writeFile(path.join(d, 'c-notas.txt'), '<script>alert(1)</script>');
    await writeFile(path.join(d, 'd-plano.pdf'), '%PDF-1.4');
    await writeFile(path.join(d, 'e-dibujo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await writeFile(path.join(d, 'f-video.mp4'), 'mp4');
    await writeFile(path.join(d, 'g-iphone.mov'), 'mov');
    await writeFile(path.join(d, 'h-peli.mkv'), 'mkv');
    await writeFile(path.join(d, 'i-informe.docx'), 'docx');
    await writeFile(path.join(d, 'j-datos.bin'), 'bin');
    store = new ShareStore(h.db);
    userId = insertUser(h.db, 'ana', 'owner');
    plain = await buildGuestApp({ db: h.db, store, guardian: h.gate, logger: false });
    full = await buildGuestApp({
      db: h.db,
      store,
      guardian: h.gate,
      logger: false,
      media: fakeMedia(
        {
          'g-iphone.mov': { playback: 'transcode', directType: 'video/mp4; codecs="hvc1.1.6.L153.B0"' },
          'h-peli.mkv': { playback: 'remux' },
        },
        calls,
      ),
    });
  });

  after(async () => {
    await plain.close();
    await full.close();
    await h.dispose();
  });

  const make = (p: string, kind: 'file' | 'dir', extra: { maxDownloads?: number } = {}) =>
    store.create({ path: p, kind, name: p.split('/').pop() ?? '', userId, expiresInDays: 7, passwordHash: null, maxDownloads: extra.maxDownloads ?? null }, new Date());
  const visit = (app: FastifyInstance, url: string) => app.inject({ method: 'GET', url, headers: { 'accept-language': 'es' } });

  it('archivo de imagen: la página la muestra; el original va «inline», aislado y sin contar como descarga', async () => {
    const { share, token } = make('/Viaje/a-foto.jpg', 'file');
    const page = await visit(plain, `/s/${token}`);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, new RegExp(`<img src="/s/${token}/v" alt="a-foto\\.jpg">`));
    assert.doesNotMatch(page.body, /<script/i);
    const csp = String(page.headers['content-security-policy']);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src/);

    const image = await visit(plain, `/s/${token}/v`);
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers['content-type'], 'image/jpeg');
    assert.match(String(image.headers['content-disposition']), /^inline; filename="a-foto\.jpg"/);
    assert.match(String(image.headers['content-security-policy']), /^sandbox; default-src 'none'; frame-ancestors 'self'$/);
    assert.equal(image.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(image.headers['x-content-type-options'], 'nosniff');
    assert.equal(store.get(share.id)?.downloads, 0, 'ver no es descargar');
    assert.equal(h.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'share.view' AND path = '/Viaje/a-foto.jpg'`).get()?.['n'], 1);
  });

  it('con límite de descargas no hay vista: verlo ya sería descargarlo', async () => {
    const { token } = make('/Viaje/a-foto.jpg', 'file', { maxDownloads: 1 });
    const page = await visit(plain, `/s/${token}`);
    assert.doesNotMatch(page.body, /<img src=/);
    assert.match(page.body, /Queda 1 descarga/);
    assert.equal((await visit(plain, `/s/${token}/v`)).statusCode, 404);
  });

  it('carpeta: lo que se puede ver abre el visor (con anterior y siguiente) y lo demás se descarga', async () => {
    const { token } = make('/Viaje', 'dir');
    const list = (await visit(plain, `/s/${token}`)).body;
    const ver = (name: string): string => `/s/${token}/ver?p=${encodeURIComponent(`/${name}`)}`;
    assert.ok(list.includes(`href="${ver('a-foto.jpg')}"`), 'imagen → visor');
    assert.ok(list.includes(`href="${ver('c-notas.txt')}"`), 'texto → visor');
    assert.ok(list.includes(`href="${ver('d-plano.pdf')}"`), 'PDF → visor');
    assert.ok(list.includes(`href="${ver('f-video.mp4')}"`), 'MP4 → visor');
    assert.ok(!list.includes(ver('e-dibujo.svg')), 'SVG: solo descarga');
    assert.ok(!list.includes(ver('h-peli.mkv')), 'MKV sin ffmpeg: solo descarga');
    assert.ok(!list.includes(ver('i-informe.docx')), 'Office sin LibreOffice: solo descarga');
    assert.ok(!list.includes(ver('j-datos.bin')));
    assert.ok(list.includes(`/s/${token}/f?p=${encodeURIComponent('/a-foto.jpg')}`), 'y su botón de descarga');

    const text = await visit(plain, ver('c-notas.txt'));
    assert.equal(text.statusCode, 200);
    assert.match(text.body, new RegExp(`<iframe src="/s/${token}/v\\?p=%2Fc-notas\\.txt" title="c-notas\\.txt" sandbox>`));
    assert.match(text.body, new RegExp(`class="prev" href="${ver('a-foto.jpg').replace(/[.?]/g, '\\$&')}"`));
    assert.match(text.body, new RegExp(`class="next" href="${ver('d-plano.pdf').replace(/[.?]/g, '\\$&')}"`));
    assert.match(text.body, /Volver a la carpeta/);
    const raw = await visit(plain, `/s/${token}/v?p=${encodeURIComponent('/c-notas.txt')}`);
    assert.equal(raw.headers['content-type'], 'text/plain; charset=utf-8', 'el texto nunca se interpreta');
    assert.match(String(raw.headers['content-security-policy']), /^sandbox/);

    const pdf = await visit(plain, `/s/${token}/v?p=${encodeURIComponent('/d-plano.pdf')}`);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.headers['content-security-policy'], "frame-ancestors 'self'", 'el visor de PDF no abre aislado');

    const video = await visit(plain, ver('f-video.mp4'));
    assert.match(video.body, new RegExp(`<video controls playsinline preload="metadata"><source src="/s/${token}/v\\?p=%2Ff-video\\.mp4" type="video/mp4"></video>`));
    const ranged = await plain.inject({ method: 'GET', url: `/s/${token}/v?p=${encodeURIComponent('/f-video.mp4')}`, headers: { range: 'bytes=1-' } });
    assert.equal(ranged.statusCode, 206, 'se puede saltar a otro punto del vídeo');
    assert.equal(ranged.body, 'p4');
  });

  it('nada fuera de lo compartido ni de los tipos permitidos', async () => {
    const { token } = make('/Viaje', 'dir');
    for (const bad of ['/../secreto.txt', '/Sub/../../x', '/e-dibujo.svg', '/j-datos.bin', '/h-peli.mkv', '/b-movil.heic']) {
      assert.equal((await visit(plain, `/s/${token}/v?p=${encodeURIComponent(bad)}`)).statusCode, 404, bad);
    }
    assert.equal((await visit(plain, `/s/${token}/img?p=${encodeURIComponent('/b-movil.heic')}`)).statusCode, 404, 'sin ffmpeg no se convierte');
    assert.equal((await visit(plain, `/s/${token}/doc?p=${encodeURIComponent('/i-informe.docx')}`)).statusCode, 404);
    assert.equal((await visit(plain, `/s/${token}/ver?p=${encodeURIComponent('/../x')}`)).statusCode, 404);
  });

  it('con visores: HEIC convertida, Office como PDF y vídeo con el original primero y la conversión después', async () => {
    const { token } = make('/Viaje', 'dir');
    const heic = await visit(full, `/s/${token}/ver?p=${encodeURIComponent('/b-movil.heic')}`);
    assert.match(heic.body, new RegExp(`<img src="/s/${token}/img\\?p=%2Fb-movil\\.heic"`));
    const jpeg = await visit(full, `/s/${token}/img?p=${encodeURIComponent('/b-movil.heic')}`);
    assert.equal(jpeg.headers['content-type'], 'image/jpeg');
    assert.equal(jpeg.body, 'jpeg!');

    const office = await visit(full, `/s/${token}/ver?p=${encodeURIComponent('/i-informe.docx')}`);
    assert.match(office.body, new RegExp(`<iframe src="/s/${token}/doc\\?p=%2Fi-informe\\.docx" title="i-informe\\.docx">`));
    const pdf = await visit(full, `/s/${token}/doc?p=${encodeURIComponent('/i-informe.docx')}`);
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.equal(pdf.body, '%PDF-1.7');
    assert.deepEqual(calls, ['image /Viaje/b-movil.heic', 'office /Viaje/i-informe.docx']);

    const hevc = await visit(full, `/s/${token}/ver?p=${encodeURIComponent('/g-iphone.mov')}`);
    assert.ok(
      hevc.body.includes(`<source src="/s/${token}/v?p=%2Fg-iphone.mov" type="video/mp4; codecs=&quot;hvc1.1.6.L153.B0&quot;"><source src="/s/${token}/stream?p=%2Fg-iphone.mov" type="video/mp4">`),
      'el navegador que entiende HEVC usa el original; el resto, la conversión',
    );
    const mkv = await visit(full, `/s/${token}/ver?p=${encodeURIComponent('/h-peli.mkv')}`);
    assert.ok(mkv.body.includes(`<source src="/s/${token}/stream?p=%2Fh-peli.mkv" type="video/mp4"></video>`));
    assert.equal((await visit(full, `/s/${token}/stream?p=${encodeURIComponent('/h-peli.mkv')}`)).statusCode, 429, 'conversiones ocupadas');
  });

  it('sin disco, el visor dice «no disponible» (nunca vacío)', async () => {
    const { token } = make('/Viaje', 'dir');
    h.gate.disconnect();
    try {
      const response = await visit(plain, `/s/${token}/ver?p=${encodeURIComponent('/a-foto.jpg')}`);
      assert.equal(response.statusCode, 503);
      assert.equal((await visit(plain, `/s/${token}/v?p=${encodeURIComponent('/a-foto.jpg')}`)).statusCode, 503);
    } finally {
      h.gate.reconnect();
    }
  });
});
