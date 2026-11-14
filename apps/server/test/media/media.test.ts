import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { MediaService } from '../../src/media/service.ts';
import { createHarness } from '../support/harness.ts';
import {
  convertOffice,
  detectTools,
  inlineContentType,
  makeThumbnail,
  probe,
  runTool,
  spawnPlayback,
  viewerKind,
  type MediaTools,
} from '../../src/media/media.ts';

describe('visores: clasificación de tipos', () => {
  it('cada extensión va a su visor', () => {
    const cases: Array<[string, string]> = [
      ['foto.JPG', 'image'], ['raw.heic', 'image'], ['scan.tiff', 'image'], ['doc.pdf', 'pdf'],
      ['peli.mkv', 'video'], ['clip.avi', 'video'], ['canción.m4a', 'audio'], ['voz.wma', 'audio'],
      ['informe.docx', 'office'], ['cuentas.xlsx', 'office'], ['charla.pptx', 'office'],
      ['notas.md', 'text'], ['Makefile', 'text'], ['programa.exe', 'none'],
    ];
    for (const [name, kind] of cases) assert.equal(viewerKind(name), kind, name);
  });

  it('en línea solo tipos seguros; HTML y SVG-texto nunca se interpretan', () => {
    assert.equal(inlineContentType('pagina.html'), 'text/plain; charset=utf-8');
    assert.equal(inlineContentType('foto.png'), 'image/png');
    assert.equal(inlineContentType('doc.pdf'), 'application/pdf');
    assert.equal(inlineContentType('programa.exe'), null);
    assert.equal(inlineContentType('informe.docx'), null);
  });
});

describe('visores con ffmpeg y LibreOffice (si están instalados)', () => {
  let tools: MediaTools;
  let dir: string;

  before(async () => {
    tools = await detectTools();
    dir = await mkdtemp(path.join(os.tmpdir(), 'pcloud-media-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Genera un clip de prueba con el propio ffmpeg (patrón de color + tono). */
  async function makeClip(name: string, videoCodec: string, audioCodec: string): Promise<string> {
    const file = path.join(dir, name);
    const result = await runTool(
      tools.ffmpeg as string,
      ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
        '-c:v', videoCodec, '-c:a', audioCodec, '-shortest', file],
      { timeoutMs: 60_000 },
    );
    assert.equal(result.code, 0, result.stderr);
    return file;
  }

  it('MKV con H.264 se reempaqueta; AVI con MPEG-4 se recodifica; el flujo es MP4', async (t) => {
    if (tools.ffmpeg === null || tools.ffprobe === null) return t.skip('ffmpeg no instalado');
    const mkv = await makeClip('h264.mkv', 'libx264', 'aac');
    const info = await probe(tools, mkv, 'h264.mkv');
    assert.equal(info.playback, 'remux');
    assert.equal(info.video?.codec, 'h264');
    assert.ok((info.duration ?? 0) > 2.5);

    const avi = await makeClip('xvid.avi', 'mpeg4', 'libmp3lame');
    const aviInfo = await probe(tools, avi, 'xvid.avi');
    assert.equal(aviInfo.playback, 'transcode');

    for (const [file, mediaInfo] of [[mkv, info], [avi, aviInfo]] as const) {
      const child = spawnPlayback(tools, file, mediaInfo, 1);
      const chunks: Buffer[] = [];
      for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
      const output = Buffer.concat(chunks);
      assert.ok(output.length > 1000, `${path.basename(file)}: flujo vacío`);
      assert.equal(output.subarray(4, 8).toString('latin1'), 'ftyp', 'MP4 fragmentado');
      // Debe poder decodificarse de verdad (el codificador por hardware producía MP4 no válidos).
      const saved = path.join(dir, `${path.basename(file)}.stream.mp4`);
      await writeFile(saved, output);
      const check = await runTool(tools.ffprobe as string, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', saved], { timeoutMs: 30_000 });
      assert.equal(check.code, 0, check.stderr);
      assert.match(check.stdout.toString(), /h264/, `${path.basename(file)}: sin vídeo H.264 decodificable`);
      const decode = await runTool(tools.ffmpeg as string, ['-v', 'error', '-i', saved, '-f', 'null', '-'], { timeoutMs: 60_000 });
      assert.equal(decode.stderr.trim(), '', `${path.basename(file)}: errores al decodificar: ${decode.stderr}`);
    }
  });

  it('MP4 H.264 + AAC se reproduce directamente; miniatura JPEG de vídeo e imagen', async (t) => {
    if (tools.ffmpeg === null || tools.ffprobe === null) return t.skip('ffmpeg no instalado');
    const mp4 = await makeClip('directo.mp4', 'libx264', 'aac');
    assert.equal((await probe(tools, mp4, 'directo.mp4')).playback, 'direct');
    const thumb = await makeThumbnail(tools, mp4, 'video', 160, 3);
    assert.equal(thumb[0], 0xff);
    assert.equal(thumb[1], 0xd8);
    const png = path.join(dir, 'imagen.png');
    await runTool(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1200x800', '-frames:v', '1', png], { timeoutMs: 30_000 });
    const imageThumb = await makeThumbnail(tools, png, 'image', 320, null);
    assert.equal(imageThumb[0], 0xff);
  });

  it('varias miniaturas de vídeo a la vez no se bloquean entre sí (análisis con límite propio)', async (t) => {
    if (tools.ffmpeg === null || tools.ffprobe === null) return t.skip('ffmpeg no instalado');
    const h = await createHarness();
    try {
      for (const name of ['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv']) {
        const result = await runTool(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=2', '-c:v', 'libx264', path.join(h.dataRoot, name)], { timeoutMs: 60_000 });
        assert.equal(result.code, 0, result.stderr);
      }
      const service = new MediaService(h.gate, tools);
      const all = Promise.all(['a.mkv', 'b.mkv', 'c.mkv', 'd.mkv'].map(async (name) => service.thumbnail(await service.resolve(`/${name}`), 160)));
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('interbloqueo: las miniaturas no terminan')), 60_000));
      const served = (await Promise.race([all, timeout])) as Array<{ size: number }>;
      assert.equal(served.length, 4);
      assert.ok(served.every((item) => item.size > 0));
    } finally {
      await h.dispose();
    }
  });

  it('un archivo que no es multimedia se rechaza sin colgar el servidor', async (t) => {
    if (tools.ffprobe === null) return t.skip('ffmpeg no instalado');
    const fake = path.join(dir, 'falso.mp4');
    await writeFile(fake, 'esto no es un vídeo');
    await assert.rejects(probe(tools, fake, 'falso.mp4'));
  });

  it('documento de oficina → PDF sin tocar el original', async (t) => {
    if (tools.soffice === null) return t.skip('LibreOffice no instalado');
    const rtf = path.join(dir, 'carta.rtf');
    const original = '{\\rtf1\\ansi Hola desde Personal Cloud}';
    await writeFile(rtf, original);
    const cache = path.join(dir, 'cache');
    const pdf = await convertOffice(tools, rtf, 'carta.rtf', cache);
    assert.equal((await readFile(pdf)).subarray(0, 5).toString('latin1'), '%PDF-');
    assert.equal(await readFile(rtf, 'utf8'), original);
    // Segunda conversión con el MISMO perfil (caso real; LibreOffice puede salir con código 134).
    const again = await convertOffice(tools, rtf, 'carta.rtf', cache);
    assert.equal((await readFile(again)).subarray(0, 5).toString('latin1'), '%PDF-');
  });
});
