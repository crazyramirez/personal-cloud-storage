/**
 * Rutas de visores: capacidades, análisis multimedia, flujo reproducible, miniaturas, imágenes
 * convertidas y documentos de oficina como PDF.
 *
 * Todo lo que se muestra dentro de la aplicación procede de archivos del usuario (no fiables):
 * se sirve con `nosniff`, sin poder ejecutar scripts y solo enmarcable por la propia aplicación.
 */

import { createReadStream } from 'node:fs';
import {
  MediaPathQuery,
  MediaStreamQuery,
  ThumbQuery,
  type MediaCapabilities,
  type MediaInfoResponse,
} from '@pcloud/contracts';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { audit } from '../auth/sessions.ts';
import { AppError } from '../errors.ts';
import { viewerKind } from '../media/media.ts';
import type { Served } from '../media/service.ts';
import { contentDisposition, type RouteContext } from './context.ts';

const API = '/api/v1';
const THUMB_SIZES = [160, 320, 640];

function sendServed(reply: FastifyReply, served: Served, name: string, cacheSeconds: number): FastifyReply {
  void reply
    .header('content-type', served.contentType)
    .header('content-length', served.size)
    .header('content-disposition', contentDisposition(name, true))
    .header('cache-control', `private, max-age=${cacheSeconds}`)
    .header('x-frame-options', 'SAMEORIGIN')
    .header(
      'content-security-policy',
      served.contentType === 'application/pdf'
        ? "default-src 'none'; frame-ancestors 'self'" // el visor PDF del navegador no funciona en «sandbox»
        : "sandbox; default-src 'none'; frame-ancestors 'self'",
    );
  return reply.send(served.file !== undefined ? createReadStream(served.file) : served.buffer);
}

export function registerMediaRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { media, db, clock } = ctx;

  app.get(`${API}/media/capabilities`, async (request): Promise<MediaCapabilities> => {
    ctx.user(request);
    return media.capabilities;
  });

  app.get(`${API}/media/info`, { schema: { querystring: MediaPathQuery } }, async (request): Promise<MediaInfoResponse> => {
    ctx.user(request);
    const file = await media.resolve((request.query as MediaPathQuery).path);
    return media.info(file);
  });

  app.get(`${API}/media/stream`, { schema: { querystring: MediaStreamQuery } }, async (request, reply) => {
    const session = ctx.user(request);
    const query = request.query as MediaStreamQuery;
    const file = await media.resolve(query.path);
    const started = await media.stream(file, query.t ?? 0);
    if (started === null) {
      throw new AppError('RATE_LIMITED', 'Ya hay otras reproducciones convertidas en curso. Ciérralas o espera un momento.', { retryable: true });
    }
    const { child } = started;
    child.once('error', (error) => {
      request.log.warn({ err: error }, 'no se pudo lanzar ffmpeg');
      if (!reply.sent) void reply.code(503).send({ error: { code: 'UNSUPPORTED_MEDIA', message: 'No se pudo iniciar la conversión', requestId: request.id, retryable: true } });
    });
    if ((query.t ?? 0) === 0) audit(db, { userId: session.userId, action: 'fs.play', path: query.path, result: 'ok', ip: request.ip }, clock());
    // Si el navegador cierra la conexión (cambia de punto, cierra el visor), se detiene ffmpeg.
    const stop = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    request.raw.once('close', stop);
    reply.raw.once('close', stop);
    child.stderr.resume();
    return reply
      .header('content-type', 'video/mp4')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'SAMEORIGIN')
      .header('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'self'")
      .send(child.stdout);
  });

  app.get(`${API}/preview/thumb`, { schema: { querystring: ThumbQuery } }, async (request, reply) => {
    ctx.user(request);
    const query = request.query as ThumbQuery;
    const wanted = query.size ?? 320;
    const size = THUMB_SIZES.find((candidate) => candidate >= wanted) ?? 640;
    const file = await media.resolve(query.path);
    const served = await media.thumbnail(file, size);
    return sendServed(reply, served, `${file.name}.jpg`, 86_400);
  });

  app.get(`${API}/preview/image`, { schema: { querystring: MediaPathQuery } }, async (request, reply) => {
    ctx.user(request);
    const file = await media.resolve((request.query as MediaPathQuery).path);
    if (viewerKind(file.name) !== 'image') throw new AppError('UNSUPPORTED_MEDIA', 'No es una imagen');
    return sendServed(reply, await media.image(file), `${file.name}.jpg`, 3600);
  });

  app.get(`${API}/preview/document`, { schema: { querystring: MediaPathQuery } }, async (request, reply) => {
    const session = ctx.user(request);
    const query = request.query as MediaPathQuery;
    const file = await media.resolve(query.path);
    if (viewerKind(file.name) !== 'office') throw new AppError('UNSUPPORTED_MEDIA', 'No es un documento de oficina');
    const served = await media.office(file);
    audit(db, { userId: session.userId, action: 'fs.preview', path: query.path, result: 'ok', ip: request.ip }, clock());
    return sendServed(reply, served, `${file.name}.pdf`, 3600);
  });
}
