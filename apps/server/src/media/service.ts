/**
 * Servicio de visores: decide cómo mostrar cada archivo y ejecuta las conversiones con límites
 * de concurrencia y caché en el HDD (`.pcloud/cache`). Sin disco escribible (solo lectura) las
 * miniaturas e imágenes se generan igualmente sin guardarlas; los documentos necesitan escribir.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { MediaCapabilities } from '@pcloud/contracts';
import { AppError } from '../errors.ts';
import { parseClientPath, resolveInside } from '../storage/paths.ts';
import { assertSpaceFor, type SpacePolicy } from '../storage/space.ts';
import type { VolumeLease } from '../storage/storage-guardian.ts';
import type { VolumeGate } from '../storage/uploads.ts';
import {
  cacheKey,
  convertImage,
  convertOffice,
  detectTools,
  Limiter,
  makeThumbnail,
  probe,
  pruneCache,
  readCached,
  removeWork,
  spawnPlayback,
  viewerKind,
  writeCached,
  type MediaInfo,
  type MediaTools,
} from './media.ts';

const CACHE_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_STREAMS = 2;

export interface ResolvedFile {
  readonly abs: string;
  readonly rel: string;
  readonly name: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly lease: VolumeLease;
}

export interface Served {
  readonly file?: string;
  readonly buffer?: Buffer;
  readonly size: number;
  readonly contentType: string;
}

export class MediaService {
  readonly #gate: VolumeGate;
  #tools: MediaTools = { ffmpeg: null, ffprobe: null, soffice: null, hwEncoder: null };
  readonly #thumbs = new Limiter(2);
  /** Los análisis (ffprobe) tienen su propio límite: nunca esperan a una plaza de miniaturas. */
  readonly #probeLimiter = new Limiter(2);
  readonly #office = new Limiter(1);
  readonly #streams = new Limiter(MAX_STREAMS);
  readonly #probes = new Map<string, Promise<MediaInfo>>();

  readonly #space: SpacePolicy;

  constructor(gate: VolumeGate, tools?: MediaTools, space: SpacePolicy = { minFreePercent: 0, minFreeBytes: 0 }) {
    this.#gate = gate;
    if (tools !== undefined) this.#tools = tools;
    this.#space = space;
  }

  async init(): Promise<MediaTools> {
    this.#tools = await detectTools();
    return this.#tools;
  }

  /** Ruta de fio (test de velocidad del disco), si está instalado. */
  get fio(): string | null {
    return this.#tools.fio ?? null;
  }

  get capabilities(): MediaCapabilities {
    return { ffmpeg: this.#tools.ffmpeg !== null, office: this.#tools.soffice !== null, hardwareVideo: this.#tools.hwEncoder !== null };
  }

  #cacheDir(lease: VolumeLease): string {
    return path.join(lease.internalDir, 'cache');
  }

  async resolve(clientPath: string): Promise<ResolvedFile> {
    const lease = await this.#gate.assertReadableVolume();
    const segments = parseClientPath(clientPath);
    const name = segments.at(-1);
    if (name === undefined) throw new AppError('NOT_FOUND', 'No es un archivo');
    const file = await resolveInside(lease.dataRoot, segments, 'file');
    return { abs: file.abs, rel: segments.join('/'), name, size: file.stats.size, mtimeMs: file.stats.mtimeMs, lease };
  }

  info(file: ResolvedFile): Promise<MediaInfo> {
    const key = `${file.rel}\0${file.size}\0${file.mtimeMs}`;
    let pending = this.#probes.get(key);
    if (pending === undefined) {
      pending = this.#probeLimiter.run(() => probe(this.#tools, file.abs, file.name));
      this.#probes.set(key, pending);
      if (this.#probes.size > 500) this.#probes.delete(this.#probes.keys().next().value as string);
      pending.catch(() => this.#probes.delete(key));
    }
    return pending;
  }

  /** Flujo reproducible por el navegador. Devuelve null si ya hay demasiados en curso. */
  async stream(file: ResolvedFile, start: number): Promise<{ child: ChildProcessWithoutNullStreams; release: () => void } | null> {
    const info = await this.info(file);
    if (info.playback === 'none') throw new AppError('UNSUPPORTED_MEDIA', 'Este archivo no tiene audio ni vídeo reproducible');
    const release = this.#streams.tryAcquire();
    if (release === null) return null;
    try {
      const child = spawnPlayback(this.#tools, file.abs, info, start);
      child.once('close', release);
      child.once('error', release);
      return { child, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async #cachedOrBuild(file: ResolvedFile, kind: 'thumbs' | 'images', variant: string, build: () => Promise<Buffer>): Promise<Served> {
    const cacheDir = this.#cacheDir(file.lease);
    const key = cacheKey(file.rel, file.size, file.mtimeMs, variant);
    const hit = await readCached(cacheDir, kind, key, 'jpg');
    if (hit !== null) return { file: hit.file, size: hit.size, contentType: 'image/jpeg' };
    const buffer = await this.#thumbs.run(build);
    try {
      const writable = await this.#gate.assertWritableVolume();
      await this.#gate.revalidate(writable);
      await writeCached(cacheDir, kind, key, 'jpg', buffer);
    } catch {
      // Solo lectura o disco ocupado: se sirve sin guardar en caché.
    }
    return { buffer, size: buffer.length, contentType: 'image/jpeg' };
  }

  async thumbnail(file: ResolvedFile, size: number): Promise<Served> {
    const kind = viewerKind(file.name);
    if (kind !== 'image' && kind !== 'video' && kind !== 'audio') throw new AppError('UNSUPPORTED_MEDIA', 'Sin vista previa para este tipo de archivo');
    if (file.size === 0) throw new AppError('UNSUPPORTED_MEDIA', 'El archivo está vacío');
    // La duración (para elegir el fotograma) se obtiene ANTES de ocupar una plaza de miniaturas.
    const duration = kind === 'video' ? ((await this.info(file).catch(() => null))?.duration ?? null) : null;
    return this.#cachedOrBuild(file, 'thumbs', `thumb-${size}`, () => makeThumbnail(this.#tools, file.abs, kind, size, duration));
  }

  image(file: ResolvedFile): Promise<Served> {
    return this.#cachedOrBuild(file, 'images', 'image-2560', () => convertImage(this.#tools, file.abs));
  }

  /** Documento de oficina → PDF (caché en el HDD). Requiere disco escribible. */
  async office(file: ResolvedFile): Promise<Served> {
    const cacheDir = this.#cacheDir(file.lease);
    const key = cacheKey(file.rel, file.size, file.mtimeMs, 'office-pdf');
    const hit = await readCached(cacheDir, 'docs', key, 'pdf');
    if (hit !== null) return { file: hit.file, size: hit.size, contentType: 'application/pdf' };
    const lease = await this.#gate.assertWritableVolume();
    return this.#office.run(async () => {
      const again = await readCached(cacheDir, 'docs', key, 'pdf');
      if (again !== null) return { file: again.file, size: again.size, contentType: 'application/pdf' };
      // La copia de trabajo y el PDF van al HDD: deben respetar la reserva de espacio.
      await assertSpaceFor(lease.mountPoint, this.#space, file.size * 2 + 64 * 1024 * 1024);
      await this.#gate.revalidate(lease);
      const output = await convertOffice(this.#tools, file.abs, file.name, cacheDir);
      try {
        await this.#gate.revalidate(lease); // la conversión puede tardar minutos
        const cached = await writeCached(cacheDir, 'docs', key, 'pdf', output);
        return { file: cached, size: (await stat(cached)).size, contentType: 'application/pdf' };
      } finally {
        await removeWork(cacheDir, output).catch(() => undefined);
      }
    });
  }

  /** Poda la caché de vistas previas (housekeeping, con disco escribible). */
  async prune(): Promise<number> {
    const lease = await this.#gate.assertWritableVolume();
    return pruneCache(this.#cacheDir(lease), CACHE_MAX_BYTES);
  }
}
