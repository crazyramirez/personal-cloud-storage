/**
 * Prueba de velocidad de la red entre el navegador y el servidor (panel → Equipo).
 *
 * Mide el camino real (Wi-Fi, cable, Tailscale) sin tocar ningún disco: la descarga sale de un
 * bloque aleatorio en memoria (no se puede comprimir) y la subida se cuenta y se descarta.
 * Una prueba a la vez por servidor, con tamaño acotado, para que nadie sature la Raspberry Pi.
 */

import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { NetTestDownloadQuery, UPLOAD_CONTENT_TYPE, type NetTestUploadResponse } from '@pcloud/contracts';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors.ts';
import type { RouteContext } from './context.ts';

const API = '/api/v1';
const MiB = 1024 * 1024;
const MAX_UPLOAD = 32 * MiB;
const BLOCK = randomBytes(MiB);


export function registerSystemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  let running = 0;
  const acquire = (): (() => void) => {
    if (running >= 2) throw new AppError('RATE_LIMITED', 'Ya hay una prueba de red en curso', { retryable: true });
    running += 1;
    let released = false;
    return () => {
      if (!released) running -= 1;
      released = true;
    };
  };

  app.get(`${API}/system/nettest/download`, { schema: { querystring: NetTestDownloadQuery } }, async (request, reply) => {
    ctx.user(request);
    const release = acquire();
    const total = (request.query as NetTestDownloadQuery).bytes;
    let sent = 0;
    const stream = new Readable({
      read() {
        if (sent >= total) {
          this.push(null);
          return;
        }
        const size = Math.min(BLOCK.length, total - sent);
        sent += size;
        this.push(size === BLOCK.length ? BLOCK : BLOCK.subarray(0, size));
      },
    });
    stream.on('close', release);
    reply.raw.on('close', release);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-length', total)
      .header('cache-control', 'no-store, no-transform')
      .send(stream);
  });

  app.post(`${API}/system/nettest/upload`, async (request): Promise<NetTestUploadResponse> => {
    ctx.user(request);
    if (request.headers['content-type'] !== UPLOAD_CONTENT_TYPE) throw new AppError('VALIDATION_FAILED', `El contenido debe enviarse como ${UPLOAD_CONTENT_TYPE}`);
    const release = acquire();
    try {
      let bytes = 0;
      for await (const chunk of request.body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD) throw new AppError('PAYLOAD_TOO_LARGE', 'La prueba de subida admite como mucho 32 MB por envío');
      }
      return { bytes };
    } finally {
      release();
    }
  });
}
