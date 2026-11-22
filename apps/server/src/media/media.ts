/**
 * Visores: tipos que el navegador muestra tal cual, y conversiones en la Pi para el resto.
 *
 *  - Multimedia (ffmpeg): análisis con ffprobe, miniaturas, imágenes que el navegador no abre
 *    (TIFF, HEIC…) y reproducción de vídeo/audio en formatos no compatibles (AVI, MKV, WMV…)
 *    reempaquetando (si el códec ya es compatible: casi sin CPU) o recodificando (H.264 por
 *    hardware de la Pi cuando existe).
 *  - Documentos de oficina (LibreOffice sin interfaz): conversión a PDF.
 *
 * Seguridad: los programas se ejecutan sin shell, con argumentos fijos, solo con el protocolo
 * `file:`, con tiempo máximo y dentro del aislamiento de pcloud.service (sin red fuera de
 * loopback). Las cachés y los ficheros de trabajo van al HDD (`.pcloud/cache`), nunca a la microSD.
 * El original no se modifica nunca.
 */

import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, open, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../errors.ts';

/** Las conversiones van con prioridad baja: nunca deben quitar CPU a la API ni a las subidas. */
function lowPriority(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    os.setPriority(child.pid, 15);
  } catch {
    // Sin permiso para cambiar la prioridad: se continúa con la normal.
  }
}

const CACHE_VERSION = 'v1';
const MiB = 1024 * 1024;

// ── Tipos de archivo ────────────────────────────────────────────────────────────────────────

export type ViewerKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'office' | 'none';

/** Tipos que el navegador muestra directamente (servidos «inline» con estas cabeceras). */
const INLINE_TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', oga: 'audio/ogg', ogg: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/mp4',
  pdf: 'application/pdf',
};

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'jsonc', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'css', 'scss', 'less', 'html', 'htm', 'py', 'rb', 'php', 'java',
  'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'sql', 'srt', 'vtt',
  'tex', 'gitignore', 'dockerfile', 'makefile', 'properties', 'gradle', 'lua', 'pl', 'r', 'dart',
]);
const IMAGE_CONVERT = new Set(['tif', 'tiff', 'heic', 'heif', 'jxl', 'tga', 'psd', 'dng', 'cr2', 'nef', 'arw', 'orf', 'rw2', 'pcx', 'ppm', 'pgm']);
const IMAGE_NATIVE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'mts', 'ts', '3gp', 'vob', 'divx', 'xvid', 'asf', 'rm', 'rmvb']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'oga', 'ogg', 'opus', 'wav', 'flac', 'weba', 'wma', 'aiff', 'aif', 'ape', 'alac', 'amr', 'mka', 'ac3', 'dts', 'mid']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv-office', 'ppt', 'pptx', 'odp', 'pps', 'ppsx', 'odg', 'vsd', 'vsdx', 'pub', 'wpd', 'pages', 'numbers', 'key']);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name.toLowerCase(); // «Makefile», «.gitignore»
  return name.slice(dot + 1).toLowerCase();
}

export function viewerKind(name: string): ViewerKind {
  const ext = extensionOf(name);
  if (IMAGE_NATIVE.has(ext) || IMAGE_CONVERT.has(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (OFFICE_EXTENSIONS.has(ext)) return 'office';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'none';
}

/** Tipo de contenido para mostrar en el navegador, o null si solo se puede descargar. */
export function inlineContentType(name: string): string | null {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8'; // HTML, SVG en texto, etc.: nunca se interpretan
  return INLINE_TYPES[ext] ?? null;
}

export function needsImageConversion(name: string): boolean {
  return IMAGE_CONVERT.has(extensionOf(name));
}

// ── Ejecución de herramientas ───────────────────────────────────────────────────────────────

export interface MediaTools {
  /** Herramienta de pruebas de E/S (test de velocidad del disco). */
  readonly fio?: string | null;
  readonly ffmpeg: string | null;
  readonly ffprobe: string | null;
  readonly soffice: string | null;
  /** Codificador H.264 por hardware disponible (Raspberry Pi: h264_v4l2m2m). */
  readonly hwEncoder: string | null;
}

async function executable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findTool(names: readonly string[]): Promise<string | null> {
  const dirs = (process.env['PATH'] ?? '/usr/bin:/bin').split(path.delimiter);
  for (const name of names) {
    for (const dir of [...dirs, '/usr/bin', '/usr/local/bin']) {
      const candidate = path.join(dir, name);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/** Ejecuta un programa sin shell, con tiempo máximo y límite de salida. */
export function runTool(command: string, args: readonly string[], options: { timeoutMs: number; maxOutput?: number; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Grupo de procesos propio (Linux): al agotar el tiempo se mata entero, también los nietos.
    const group = process.platform !== 'win32';
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: group });
    lowPriority(child);
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    let settled = false;
    const max = options.maxOutput ?? 64 * MiB;
    const killAll = (): void => {
      try {
        if (group && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    };
    const timer = setTimeout(() => {
      killAll();
      // Si un nieto mantiene abiertas las tuberías, «close» no llegaría nunca: se resuelve igual.
      setTimeout(() => finish(null), 2000).unref();
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > max) killAll();
      else out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 8192) err += chunk.toString();
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      // Se espera un instante a vaciar la salida; si un nieto sigue vivo, se mata el grupo.
      setTimeout(() => {
        if (!settled && group && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // El grupo ya no existe.
          }
        }
        finish(code);
      }, 300).unref();
    });
    child.on('close', (code) => finish(code));
  });
}

export async function detectTools(): Promise<MediaTools> {
  const ffmpeg = await findTool(['ffmpeg']);
  const ffprobe = await findTool(['ffprobe']);
  const soffice = await findTool(['soffice', 'libreoffice']);
  const fio = await findTool(['fio']);
  let hwEncoder: string | null = null;
  if (ffmpeg !== null && process.platform === 'linux') {
    const result = await runTool(ffmpeg, ['-hide_banner', '-encoders'], { timeoutMs: 10_000 }).catch(() => null);
    // /dev/video11 = codificador H.264 de la Raspberry Pi (bcm2835-codec-encode).
    const device = await access('/dev/video11', constants.R_OK | constants.W_OK).then(() => true, () => false);
    if (result?.stdout.toString().includes('h264_v4l2m2m') === true && device) hwEncoder = 'h264_v4l2m2m';
  }
  return { ffmpeg, ffprobe, soffice, hwEncoder, fio };
}

/** Limita cuántas conversiones pesadas se ejecutan a la vez (la Pi tiene 4 núcleos). */
export class Limiter {
  #active = 0;
  readonly #queue: Array<() => void> = [];
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) await new Promise<void>((resolve) => this.#queue.push(resolve));
    this.#active += 1;
    try {
      return await task();
    } finally {
      this.#active -= 1;
      this.#queue.shift()?.();
    }
  }

  /** Ocupa una plaza sin esperar; null si no hay libre. */
  tryAcquire(): (() => void) | null {
    if (this.#active >= this.#max) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#queue.shift()?.();
    };
  }
}

// ── Análisis y reproducción ─────────────────────────────────────────────────────────────────

export type PlaybackMode = 'direct' | 'remux' | 'transcode' | 'none';

export interface MediaInfo {
  readonly duration: number | null;
  readonly container: string | null;
  readonly video: { readonly codec: string; readonly width: number; readonly height: number } | null;
  readonly audio: { readonly codec: string; readonly channels: number } | null;
  readonly playback: PlaybackMode;
  /**
   * Tipo MIME con códecs (RFC 6381) del vídeo original cuando la Pi lo convertiría pero muchos
   * navegadores lo reproducen tal cual (HEVC/H.265 en MP4 o MOV: Safari, y Chrome, Edge o Firefox
   * con aceleración). La web lo prueba con canPlayType/MediaCapabilities y, si puede, sirve el
   * original sin convertir. null = no hay nada que probar.
   */
  readonly directType: string | null;
}

const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_u8', 'pcm_f32le']);
/** Audio que se puede copiar tal cual dentro de MP4 fragmentado. */
const MP4_AUDIO_COPY = new Set(['aac', 'mp3', 'opus']);
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mp3', 'm4a', 'aac', 'oga', 'ogg', 'opus', 'wav', 'flac', 'weba']);

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  channels?: number;
  profile?: string;
  level?: number;
  codec_tag_string?: string;
  disposition?: { attached_pic?: number };
}

/** Contenedores que el navegador abre tal cual si entiende sus códecs. */
const NATIVE_CANDIDATE_CONTAINERS = new Set(['mp4', 'm4v', 'mov']);

/**
 * Códec HEVC en formato RFC 6381 («hvc1.1.6.L153.B0»): perfil Main o Main 10, nivel de ffprobe
 * (30 × nivel: 153 = 5.1) y tier Main (ffprobe no lo informa; es lo habitual en cámaras y móviles).
 */
function hevcCodecString(stream: ProbeStream): string | null {
  const tag = stream.codec_tag_string === 'hev1' ? 'hev1' : 'hvc1';
  const profile = stream.profile === 'Main' ? '1.6' : stream.profile === 'Main 10' ? '2.4' : null;
  const level = typeof stream.level === 'number' && stream.level > 0 ? stream.level : null;
  return profile === null || level === null ? null : `${tag}.${profile}.L${level}.B0`;
}

export async function probe(tools: MediaTools, abs: string, name: string): Promise<MediaInfo> {
  if (tools.ffprobe === null) throw new AppError('UNSUPPORTED_MEDIA', 'El servidor no tiene ffmpeg instalado');
  const result = await runTool(
    tools.ffprobe,
    ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', `file:${abs}`],
    { timeoutMs: 20_000, maxOutput: 4 * MiB },
  );
  if (result.code !== 0) throw new AppError('UNSUPPORTED_MEDIA', 'No se reconoce el formato de este archivo');
  const data = JSON.parse(result.stdout.toString()) as { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  const video = v === undefined ? null : { codec: v.codec_name ?? '?', width: v.width ?? 0, height: v.height ?? 0 };
  const audio = a === undefined ? null : { codec: a.codec_name ?? '?', channels: a.channels ?? 2 };

  let playback: PlaybackMode = 'none';
  const ext = extensionOf(name);
  const videoOk = video === null || BROWSER_VIDEO.has(video.codec);
  const audioOk = audio === null || BROWSER_AUDIO.has(audio.codec);
  if (video === null && audio === null) playback = 'none';
  else if (DIRECT_CONTAINERS.has(ext) && videoOk && audioOk) playback = 'direct';
  else if (video !== null && (video.codec === 'h264' || video.codec === 'av1' || video.codec === 'vp9')) playback = 'remux';
  else if (video === null) playback = 'remux'; // solo audio: copiar o convertir a AAC es barato
  else playback = 'transcode';

  let directType: string | null = null;
  if ((playback === 'remux' || playback === 'transcode') && v !== undefined && v.codec_name === 'hevc' && audioOk && NATIVE_CANDIDATE_CONTAINERS.has(ext)) {
    const codec = hevcCodecString(v);
    if (codec !== null) directType = `video/mp4; codecs="${codec}"`;
  }

  return { duration: Number.isFinite(duration) ? duration : null, container: data.format?.format_name ?? null, video, audio, playback, directType };
}

/**
 * Lanza ffmpeg para reproducir en el navegador: MP4 fragmentado por la salida estándar.
 * `start` en segundos (para saltar a un punto: el cliente vuelve a pedir el flujo desde ahí).
 */
export function spawnPlayback(tools: MediaTools, abs: string, info: MediaInfo, start: number): ChildProcessWithoutNullStreams {
  if (tools.ffmpeg === null) throw new AppError('UNSUPPORTED_MEDIA', 'El servidor no tiene ffmpeg instalado');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe'];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', `file:${abs}`);
  if (info.video !== null) {
    args.push('-map', '0:v:0');
    if (info.playback === 'remux') {
      args.push('-c:v', 'copy');
    } else {
      // libx264 y no el codificador por hardware de la Pi (h264_v4l2m2m): este no entrega las
      // cabeceras (SPS/PPS) que exige el MP4 fragmentado y el vídeo resultante no se puede
      // reproducir (comprobado en la Pi el 2026-11-14). 720p «veryfast» va en tiempo real.
      // HEVC cuesta mucho más de decodificar: a 720p «veryfast» la Pi 4 va a 0,85× con un 1080p
      // de 15 Mbit/s y el vídeo se atasca; a 960 px «superfast», a 1,2× (medido el 2026-11-22).
      const heavy = info.video.codec === 'hevc';
      args.push(
        '-vf', `scale=w='min(${heavy ? 960 : 1280},iw)':h=-2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', heavy ? 'superfast' : 'veryfast', '-tune', 'zerolatency', '-crf', '23', '-g', '50',
        '-profile:v', 'high', '-level', '4.0',
      );
    }
  }
  if (info.audio !== null) {
    args.push('-map', '0:a:0');
    if (MP4_AUDIO_COPY.has(info.audio.codec)) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  args.push('-sn', '-dn', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
  const child = spawn(tools.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  child.on('error', () => {
    // EAGAIN/ENOENT al lanzar: la salida se cierra y quien la sirve corta la respuesta.
    child.stdout.destroy();
  });
  lowPriority(child);
  return child;
}

// ── Caché de conversiones (en el HDD) ───────────────────────────────────────────────────────

export interface CacheTarget {
  readonly abs: string;
  /** Clave estable: ruta + tamaño + fecha de modificación (si cambia el original, cambia la clave). */
  readonly key: string;
}

export function cacheKey(relPath: string, size: number, mtimeMs: number, variant: string): string {
  return createHash('sha256').update(`${CACHE_VERSION}\0${relPath}\0${size}\0${Math.floor(mtimeMs)}\0${variant}`).digest('hex');
}

export async function readCached(cacheDir: string, kind: string, key: string, ext: string): Promise<{ file: string; size: number } | null> {
  const file = path.join(cacheDir, kind, `${key}.${ext}`);
  try {
    const info = await stat(file);
    if (!info.isFile()) return null;
    const now = new Date();
    await utimes(file, now, info.mtime).catch(() => undefined); // atime = último uso (para podar)
    return { file, size: info.size };
  } catch {
    return null;
  }
}

/** Guarda en caché de forma atómica (temporal + rename). Es regenerable: no necesita fsync. */
/**
 * Crea `.pcloud/cache` (un solo nivel). Si `.pcloud` no existe —disco desmontado: el punto de
 * montaje vacío de la microSD— falla con ENOENT en lugar de crear nada fuera del HDD.
 */
export async function ensureCacheDir(cacheDir: string): Promise<void> {
  await mkdir(cacheDir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
}

export async function writeCached(cacheDir: string, kind: string, key: string, ext: string, content: Buffer | string): Promise<string> {
  const dir = path.join(cacheDir, kind);
  await ensureCacheDir(cacheDir);
  await mkdir(dir, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  });
  const file = path.join(dir, `${key}.${ext}`);
  const tmp = path.join(dir, `.${key}.${randomUUID()}.tmp`);
  if (typeof content === 'string') await copyFile(content, tmp);
  else await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, file);
  return file;
}

/** Poda la caché por uso más antiguo hasta `maxBytes`. Borra solo ficheros propios de la caché. */
export async function pruneCache(cacheDir: string, maxBytes: number): Promise<number> {
  const files: Array<{ file: string; size: number; used: number }> = [];
  for (const kind of ['thumbs', 'images', 'docs']) {
    const dir = path.join(cacheDir, kind);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!/^\.?[0-9a-f]{64}/.test(name)) continue;
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info === null || !info.isFile()) continue;
      // Temporales de más de una hora: restos de una conversión interrumpida.
      if (name.endsWith('.tmp') && Date.now() - info.mtimeMs > 3_600_000) {
        await unlink(file).catch(() => undefined);
        continue;
      }
      files.push({ file, size: info.size, used: Math.max(info.atimeMs, info.mtimeMs) });
    }
  }
  let total = files.reduce((sum, item) => sum + item.size, 0);
  let removed = 0;
  files.sort((a, b) => a.used - b.used);
  for (const item of files) {
    if (total <= maxBytes) break;
    await unlink(item.file).catch(() => undefined);
    total -= item.size;
    removed += 1;
  }
  return removed;
}

// ── Conversores ─────────────────────────────────────────────────────────────────────────────

/** Miniatura JPEG (lado mayor `size`) de una imagen o vídeo. */
export async function makeThumbnail(tools: MediaTools, abs: string, kind: 'image' | 'video' | 'audio', size: number, duration: number | null): Promise<Buffer> {
  if (tools.ffmpeg === null) throw new AppError('UNSUPPORTED_MEDIA', 'El servidor no tiene ffmpeg instalado');
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe'];
  if (kind === 'video') args.push('-ss', String(duration !== null && duration > 4 ? Math.min(duration * 0.1, 60).toFixed(2) : 0));
  args.push('-i', `file:${abs}`);
  // Audio: la carátula incrustada (ID3 APIC en MP3/AIFF/WAV, «covr» en M4A, PICTURE en FLAC) es
  // un flujo de vídeo «attached_pic». Si no hay, ffmpeg falla y el cliente muestra el icono.
  if (kind === 'audio') args.push('-map', '0:v:0', '-an');
  args.push(
    '-frames:v', '1',
    '-vf', `scale=w=${size}:h=${size}:force_original_aspect_ratio=decrease,format=yuvj420p`,
    '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '5', 'pipe:1',
  );
  const result = await runTool(tools.ffmpeg, args, { timeoutMs: 60_000, maxOutput: 8 * MiB });
  if (result.code !== 0 || result.stdout.length === 0) throw new AppError('UNSUPPORTED_MEDIA', 'No se pudo generar la vista previa');
  return result.stdout;
}

/** Imagen que el navegador no abre (TIFF, HEIC…) → JPEG de hasta 2560 px. */
export async function convertImage(tools: MediaTools, abs: string): Promise<Buffer> {
  if (tools.ffmpeg === null) throw new AppError('UNSUPPORTED_MEDIA', 'El servidor no tiene ffmpeg instalado');
  const result = await runTool(
    tools.ffmpeg,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-i', `file:${abs}`, '-frames:v', '1',
      '-vf', "scale=w='min(2560,iw)':h='min(2560,ih)':force_original_aspect_ratio=decrease,format=yuvj420p",
      '-f', 'image2', '-c:v', 'mjpeg', '-q:v', '3', 'pipe:1'],
    { timeoutMs: 120_000, maxOutput: 32 * MiB },
  );
  if (result.code !== 0 || result.stdout.length === 0) throw new AppError('UNSUPPORTED_MEDIA', 'No se pudo convertir esta imagen');
  return result.stdout;
}

/**
 * Documento de oficina → PDF con LibreOffice. Se trabaja sobre una COPIA en el HDD
 * (`.pcloud/cache/work`) para que LibreOffice no deje ficheros de bloqueo junto al original.
 */
export async function convertOffice(tools: MediaTools, abs: string, name: string, cacheDir: string): Promise<string> {
  if (tools.soffice === null) throw new AppError('UNSUPPORTED_MEDIA', 'El servidor no tiene LibreOffice instalado');
  await ensureCacheDir(cacheDir);
  for (const level of ['work', 'lo-profile']) {
    await mkdir(path.join(cacheDir, level), { mode: 0o700 }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
  }
  const work = path.join(cacheDir, 'work', randomUUID());
  const profile = path.join(cacheDir, 'lo-profile');
  await mkdir(work, { mode: 0o700 });
  try {
    const ext = extensionOf(name);
    const input = path.join(work, `documento.${/^[a-z0-9]{1,8}$/.test(ext) ? ext : 'bin'}`);
    await copyFile(abs, input);
    const output = path.join(work, 'documento.pdf');
    for (let attempt = 1; attempt <= 2; attempt++) {
      await runTool(
        tools.soffice,
        ['--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', `-env:UserInstallation=file://${profile}`,
          '--convert-to', 'pdf', '--outdir', work, input],
        { timeoutMs: 180_000, maxOutput: MiB, cwd: work, env: { ...process.env, HOME: work, SAL_USE_VCLPLUGIN: 'svp' } },
      );
      // Lo que cuenta es el resultado: LibreOffice 25.x a veces termina con error (código 134)
      // DESPUÉS de escribir un PDF correcto, al cerrarse con un perfil ya usado.
      if (await isPdf(output)) return output;
      // Sin PDF: el perfil puede estar dañado (corte, versión distinta). Se recrea y se reintenta.
      if (attempt === 1) await resetProfile(cacheDir, profile);
    }
    throw new AppError('UNSUPPORTED_MEDIA', 'No se pudo convertir este documento');
  } catch (error) {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function isPdf(file: string): Promise<boolean> {
  try {
    const handle = await open(file, 'r');
    try {
      const head = Buffer.alloc(5);
      const { bytesRead } = await handle.read(head, 0, 5, 0);
      return bytesRead === 5 && head.toString('latin1') === '%PDF-';
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

/** Recrea el perfil de LibreOffice (solo `cache/lo-profile`, propio de la aplicación). */
async function resetProfile(cacheDir: string, profile: string): Promise<void> {
  if (profile !== path.join(cacheDir, 'lo-profile')) return;
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { mode: 0o700 });
}

/** Borra el directorio de trabajo de una conversión (solo dentro de `cache/work`). */
export async function removeWork(cacheDir: string, file: string): Promise<void> {
  const workRoot = path.join(cacheDir, 'work');
  const dir = path.dirname(file);
  if (path.dirname(dir) !== workRoot) return;
  await rm(dir, { recursive: true, force: true });
}
