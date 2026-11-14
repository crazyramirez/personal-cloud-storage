/**
 * Puerta de invitados (ADR-0018): el ÚNICO servidor que se publica en Internet, por Tailscale
 * Funnel y solo mientras haya enlaces activos.
 *
 * Es una instancia de Fastify aparte, en su propio socket Unix (ver GUEST_SOCKET), que solo conoce
 * estas rutas:
 *
 *   GET  /s/<token>[?p=/sub]       página del enlace (archivo, o carpeta y sus subcarpetas)
 *   POST /s/<token>                desbloquear con la contraseña (formulario)
 *   GET  /s/<token>/f[?p=/a.mkv]   descargar un archivo
 *   GET  /s/<token>/zip[?p=/sub]   descargar una carpeta como ZIP
 *   GET  /robots.txt
 *
 * No existe aquí ninguna ruta de la API: ni sesión, ni inicio de sesión, ni escritura, ni listado
 * fuera de lo compartido. Las páginas son HTML generado en el servidor, SIN JavaScript, con una
 * CSP que solo permite su propio estilo. Siempre solo lectura.
 *
 * Defensas: token de 256 bits (se busca por su hash) · misma respuesta para «no existe», «caducado»,
 * «revocado» y «agotado» · rutas resueltas por componentes dentro de lo compartido, sin enlaces
 * simbólicos · límite de peticiones por IP · intentos de contraseña limitados por IP y por enlace ·
 * descargas simultáneas limitadas · sin disco listo, «no disponible ahora» (nunca una carpeta vacía).
 */

import { createReadStream } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import cookie from '@fastify/cookie';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { FsEntry } from '@pcloud/contracts';
import { audit } from '../auth/sessions.ts';
import { verifyPassword } from '../auth/passwords.ts';
import type { Db } from '../db/database.ts';
import { AppError, errnoOf } from '../errors.ts';
import { contentDisposition, parseRange, type GuardianLike } from '../http/context.ts';
import { listDirectory } from '../storage/files.ts';
import { formatClientPath, parseClientPath, resolveInside } from '../storage/paths.ts';
import { StorageUnavailableError } from '../storage/storage-guardian.ts';
import { planZip, streamZip } from '../storage/zip.ts';
import { stateOf, type ShareRow, type ShareStore } from './store.ts';

export interface GuestDeps {
  readonly db: Db;
  readonly store: ShareStore;
  readonly guardian: GuardianLike;
  readonly clock?: () => Date;
  readonly logger?: boolean;
  readonly logLevel?: string;
  /** Descargas simultáneas en total (protege el disco USB y la subida de casa). */
  readonly maxDownloads?: number;
  /** Se llama cuando un enlace deja de estar activo (agotado), para apagar Funnel si era el último. */
  readonly onShareChanged?: () => void;
}

const GRANT_COOKIE = 'pcloud_share';
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;
const LIST_LIMIT = 500;

// ── Textos (es/en según el navegador del invitado) ─────────────────────────────────────────

const TEXT = {
  es: {
    gone: 'Este enlace no está disponible',
    goneHint: 'Puede que haya caducado, que se haya retirado o que ya se hayan hecho todas las descargas permitidas. Pide otro a quien te lo envió.',
    moved: 'El archivo ya no está aquí',
    movedHint: 'Se ha movido o eliminado desde que se creó el enlace. Pide otro a quien te lo envió.',
    offline: 'No disponible en este momento',
    offlineHint: 'El servidor no puede leer el disco ahora mismo. Prueba de nuevo dentro de un rato.',
    busy: 'Hay demasiadas descargas a la vez',
    busyHint: 'Espera a que termine alguna y vuelve a intentarlo.',
    slow: 'Demasiadas peticiones',
    slowHint: 'Espera unos minutos y vuelve a probar.',
    locked: 'Este enlace está protegido',
    lockedHint: 'Escribe la contraseña que te dieron junto con el enlace.',
    password: 'Contraseña',
    open: 'Abrir',
    wrong: 'Contraseña incorrecta',
    download: 'Descargar',
    downloadAll: 'Descargar todo (ZIP)',
    until: 'Disponible hasta el {date}',
    left: (n: number) => (n === 1 ? 'Queda 1 descarga' : `Quedan ${n} descargas`),
    files: (n: number) => (n === 1 ? '1 elemento' : `${n} elementos`),
    more: (n: number) => `Y ${n} más: descarga el ZIP para tenerlos todos.`,
    empty: 'Esta carpeta está vacía.',
    shared: 'Compartido contigo',
    folder: 'Carpeta',
    footer: 'Enlace privado de solo lectura · Personal Cloud Storage',
    notFound: 'Página no encontrada',
  },
  en: {
    gone: 'This link isn’t available',
    goneHint: 'It may have expired, been withdrawn, or reached its download limit. Ask whoever sent it for a new one.',
    moved: 'The file is no longer here',
    movedHint: 'It was moved or deleted after the link was created. Ask whoever sent it for a new one.',
    offline: 'Not available right now',
    offlineHint: 'The server can’t read its disk at the moment. Please try again later.',
    busy: 'Too many downloads at once',
    busyHint: 'Wait for one to finish and try again.',
    slow: 'Too many requests',
    slowHint: 'Wait a few minutes and try again.',
    locked: 'This link is protected',
    lockedHint: 'Enter the password you were given with the link.',
    password: 'Password',
    open: 'Open',
    wrong: 'Wrong password',
    download: 'Download',
    downloadAll: 'Download all (ZIP)',
    until: 'Available until {date}',
    left: (n: number) => (n === 1 ? '1 download left' : `${n} downloads left`),
    files: (n: number) => (n === 1 ? '1 item' : `${n} items`),
    more: (n: number) => `And ${n} more: download the ZIP to get them all.`,
    empty: 'This folder is empty.',
    shared: 'Shared with you',
    folder: 'Folder',
    footer: 'Private read-only link · Personal Cloud Storage',
    notFound: 'Page not found',
  },
};
type Lang = keyof typeof TEXT;
type Texts = (typeof TEXT)[Lang];

const langOf = (request: FastifyRequest): Lang => (/^\s*es\b/i.test(String(request.headers['accept-language'] ?? '')) ? 'es' : 'en');

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);

function bytes(value: number, lang: Lang): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: unit === 0 ? 0 : size < 10 ? 1 : 0 }).format(size)} ${units[unit]}`;
}

const when = (iso: string, lang: Lang): string => new Intl.DateTimeFormat(lang, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(iso));

// ── Iconos (SVG en línea; trazo de 1,75 como en la app) ────────────────────────────────────

const svg = (body: string, size = 20): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICON = {
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  download: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

const STYLE = `
:root{--bg:#f5f6f8;--surface:#fff;--text:#14171c;--muted:#5d6573;--border:#e3e6eb;--accent:#2563eb;--accent-text:#fff;--soft:#eaf0fe;--danger:#c0262d;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--surface:#171a20;--text:#eceef2;--muted:#9aa3b2;--border:#2a2f38;--accent:#5b8cff;--accent-text:#0b1020;--soft:#1c2538;--danger:#ff6b6b}}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:32px 16px;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:680px;display:flex;flex-direction:column;gap:16px}
.brand{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:13px;font-weight:600}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px}
.hero{display:flex;gap:16px;align-items:flex-start}
.ico{flex:none;width:48px;height:48px;border-radius:12px;display:grid;place-items:center;background:var(--soft);color:var(--accent)}
.ico.warn{color:var(--danger)}
h1{font-size:19px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.muted{color:var(--muted)}.small{font-size:13px}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;color:var(--muted);font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;padding:0 18px;border-radius:10px;border:0;background:var(--accent);color:var(--accent-text);font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:2px;font-size:13px;margin-bottom:12px}
.crumbs a{color:var(--accent);text-decoration:none}.crumbs svg{color:var(--muted)}
ul{list-style:none;padding:0;border-top:1px solid var(--border)}
li{border-bottom:1px solid var(--border)}
li a{display:flex;align-items:center;gap:12px;padding:11px 4px;color:inherit;text-decoration:none;min-height:48px}
li a:hover{background:var(--soft)}
li .name{flex:1;min-width:0;overflow-wrap:anywhere}
li .size{color:var(--muted);font-size:13px;white-space:nowrap;font-variant-numeric:tabular-nums}
li .t{color:var(--muted);display:inline-flex}li.d .t{color:var(--accent)}
form{display:flex;flex-direction:column;gap:10px;margin-top:18px}
label{font-size:13px;font-weight:600}
input{min-height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit}
input:focus-visible,.btn:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.err{color:var(--danger);font-size:13px;font-weight:600}
.note{margin-top:14px}
.card>.small+.hero{margin-top:10px}
footer{margin-top:auto;padding-top:28px;color:var(--muted);font-size:12px;text-align:center}
`;

interface PageInput {
  readonly lang: Lang;
  readonly title: string;
  readonly body: string;
}

function page({ lang, title, body }: PageInput, nonce: string): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head><body><main><div class="brand">${svg(ICON.cloud, 18)}Personal Cloud Storage</div>${body}</main><footer>${esc(TEXT[lang].footer)}</footer></body></html>`;
}

function messageCard(icon: string, title: string, hint: string, warn = false): string {
  return `<section class="card"><div class="hero"><span class="ico${warn ? ' warn' : ''}">${svg(icon, 24)}</span><div><h1>${esc(title)}</h1><p class="muted">${esc(hint)}</p></div></div></section>`;
}

// ── Límites ────────────────────────────────────────────────────────────────────────────────

class Window {
  readonly #max: number;
  readonly #ms: number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(max: number, ms: number) {
    this.#max = max;
    this.#ms = ms;
  }

  /** true si aún se permite (y cuenta el intento). */
  take(key: string, now: number): boolean {
    const entry = this.#hits.get(key);
    if (entry === undefined || entry.resetAt <= now) {
      if (this.#hits.size > 20_000) this.#hits.clear();
      this.#hits.set(key, { count: 1, resetAt: now + this.#ms });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.#max;
  }

  blocked(key: string, now: number): boolean {
    const entry = this.#hits.get(key);
    return entry !== undefined && entry.resetAt > now && entry.count >= this.#max;
  }
}

class GuestHttpError extends Error {
  readonly status: number;
  readonly kind: 'gone' | 'moved' | 'offline' | 'busy' | 'slow' | 'notFound';

  constructor(status: number, kind: GuestHttpError['kind']) {
    super(kind);
    this.status = status;
    this.kind = kind;
  }
}

/**
 * IP del invitado. Solo tailscaled (Funnel) conecta al socket y AÑADE la IP real al final de
 * X-Forwarded-For: se usa la última entrada, nunca lo que el invitado ponga delante.
 */
function clientIp(request: FastifyRequest): string {
  const header = request.headers['x-forwarded-for'];
  const last = (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').at(-1)?.trim() ?? '';
  if (/^[0-9a-fA-F.:]{2,45}$/.test(last)) return last;
  return request.ip || 'desconocida';
}
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');

// ── Aplicación ─────────────────────────────────────────────────────────────────────────────

export async function buildGuestApp(deps: GuestDeps): Promise<FastifyInstance> {
  const { db, store, guardian } = deps;
  const clock = deps.clock ?? (() => new Date());
  const maxDownloads = deps.maxDownloads ?? 4;
  const requests = new Window(240, 60_000); // por IP
  const pinByIp = new Window(5, 15 * 60_000); // por IP y enlace
  const pinByShare = new Window(20, 60 * 60_000); // por enlace, todas las IP
  const grants = new Map<string, { shareId: string; expiresAt: number }>();
  let downloading = 0;
  let verifying = false;

  const app = Fastify({
    logger: deps.logger === false ? false : { level: deps.logLevel ?? 'info' },
    // La IP del invitado la calcula clientIp() a partir de X-Forwarded-For.
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2048,
    routerOptions: { maxParamLength: 64 },
    genReqId: () => randomBytes(8).toString('hex'),
    requestIdHeader: false,
    // Sin HEAD automático: un HEAD no debe contar como descarga ni abrir el archivo.
    exposeHeadRoutes: false,
    keepAliveTimeout: 10_000,
    requestTimeout: 60_000,
  });
  await app.register(cookie);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 2048 }, (_request, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });

  const nonceOf = (reply: FastifyReply): string => (reply as unknown as { pcloudNonce: string }).pcloudNonce;

  app.addHook('onRequest', async (request, reply) => {
    const nonce = randomBytes(16).toString('base64');
    (reply as unknown as { pcloudNonce: string }).pcloudNonce = nonce;
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex, nofollow, noarchive')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
      .header('content-security-policy', `default-src 'none'; style-src 'nonce-${nonce}'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    if (!requests.take(clientIp(request), Date.now())) throw new GuestHttpError(429, 'slow');
  });

  const sendHtml = (reply: FastifyReply, status: number, input: PageInput): FastifyReply =>
    reply.status(status).header('content-type', 'text/html; charset=utf-8').send(page(input, nonceOf(reply)));

  const errorPage = (request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply => {
    const lang = langOf(request);
    const t = TEXT[lang];
    let failure: GuestHttpError;
    if (error instanceof GuestHttpError) failure = error;
    else if (error instanceof StorageUnavailableError) failure = new GuestHttpError(503, 'offline');
    else if (error instanceof AppError && (error.code === 'NOT_FOUND' || error.code === 'INVALID_PATH')) failure = new GuestHttpError(404, 'moved');
    else if (error instanceof AppError && error.code === 'STORAGE_UNAVAILABLE') failure = new GuestHttpError(503, 'offline');
    else if (['EIO', 'ENODEV', 'ENXIO', 'ESTALE', 'ENOTCONN'].includes(errnoOf(error) ?? '')) {
      failure = new GuestHttpError(503, 'offline');
      void guardian.check().catch(() => undefined);
    } else if (typeof error === 'object' && error !== null && (error as { statusCode?: number }).statusCode !== undefined && (error as { statusCode: number }).statusCode < 500) {
      failure = new GuestHttpError(404, 'notFound');
    } else {
      request.log.error({ err: error }, 'error en la puerta de invitados');
      failure = new GuestHttpError(503, 'offline');
    }
    if (reply.sent) return reply;
    if (failure.kind === 'slow') reply.header('retry-after', '300');
    const card = {
      gone: messageCard(ICON.alert, t.gone, t.goneHint, true),
      moved: messageCard(ICON.alert, t.moved, t.movedHint, true),
      offline: messageCard(ICON.alert, t.offline, t.offlineHint, true),
      busy: messageCard(ICON.alert, t.busy, t.busyHint, true),
      slow: messageCard(ICON.alert, t.slow, t.slowHint, true),
      notFound: messageCard(ICON.alert, t.notFound, t.goneHint, true),
    }[failure.kind];
    const title = { gone: t.gone, moved: t.moved, offline: t.offline, busy: t.busy, slow: t.slow, notFound: t.notFound }[failure.kind];
    return sendHtml(reply, failure.status, { lang, title, body: card });
  };
  app.setErrorHandler((error, request, reply) => errorPage(request, reply, error));
  app.setNotFoundHandler((request, reply) => errorPage(request, reply, new GuestHttpError(404, 'notFound')));

  /** El enlace, solo si está activo. Cualquier otro caso responde igual (sin pistas). */
  const activeShare = (token: string): ShareRow => {
    const share = store.byToken(token);
    if (share === null || stateOf(share, clock()) !== 'active') throw new GuestHttpError(404, 'gone');
    return share;
  };

  const unlocked = (request: FastifyRequest, share: ShareRow): boolean => {
    if (share.passwordHash === null) return true;
    const grant = request.cookies[GRANT_COOKIE];
    if (grant === undefined || grant.length > 64) return false;
    const found = grants.get(sha(grant));
    return found !== undefined && found.shareId === share.id && found.expiresAt > Date.now();
  };

  /** Segmentos del elemento pedido dentro de lo compartido. */
  const targetSegments = (share: ShareRow, sub: unknown): string[] => {
    const base = parseClientPath(share.path);
    if (share.kind === 'file' || sub === undefined || sub === '' || sub === '/') return base;
    if (typeof sub !== 'string') throw new GuestHttpError(404, 'moved');
    const extra = sub.replace(/^\/+/, '').split('/');
    for (const segment of extra) {
      if (segment === '' || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('\u0000') || segment.length > 255) {
        throw new GuestHttpError(404, 'moved');
      }
    }
    if (extra.length > 32) throw new GuestHttpError(404, 'moved');
    return [...base, ...extra];
  };

  const relOf = (share: ShareRow, segments: readonly string[]): string => formatClientPath(segments.slice(parseClientPath(share.path).length));
  const linkTo = (token: string, suffix: string, rel: string | null): string =>
    `/s/${token}${suffix}${rel === null || rel === '/' ? '' : `?p=${encodeURIComponent(rel)}`}`;

  const lockedPage = (request: FastifyRequest, reply: FastifyReply, share: ShareRow, wrong: boolean, status = 401): FastifyReply => {
    const lang = langOf(request);
    const t = TEXT[lang];
    const token = (request.params as { token: string }).token;
    const body = `<section class="card"><div class="hero"><span class="ico">${svg(ICON.lock, 24)}</span><div><h1>${esc(t.locked)}</h1><p class="muted">${esc(t.lockedHint)}</p></div></div>
<form method="post" action="/s/${token}" autocomplete="off"><label for="pin">${esc(t.password)}</label><input id="pin" name="pin" type="password" required maxlength="128" autofocus>${wrong ? `<p class="err" role="alert">${esc(t.wrong)}</p>` : ''}<button class="btn" type="submit">${esc(t.open)}</button></form>
<p class="muted small note">${esc(t.until.replace('{date}', when(share.expiresAt, lang)))}</p></section>`;
    return sendHtml(reply, status, { lang, title: t.locked, body });
  };

  const metaLine = (share: ShareRow, t: Texts, lang: Lang): string => {
    const parts = [esc(t.until.replace('{date}', when(share.expiresAt, lang)))];
    if (share.maxDownloads !== null) parts.push(esc(t.left(Math.max(0, share.maxDownloads - share.downloads))));
    return parts.map((part) => `<span>${part}</span>`).join('');
  };

  // ── Rutas ────────────────────────────────────────────────────────────────────────────────

  app.get('/robots.txt', async (_request, reply) => reply.header('content-type', 'text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n'));

  app.get('/s/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (!unlocked(request, share)) return lockedPage(request, reply, share, false);
    const lang = langOf(request);
    const t = TEXT[lang];
    const lease = await guardian.assertReadableVolume();
    store.touch(share, clock());

    if (share.kind === 'file') {
      const file = await resolveInside(lease.dataRoot, parseClientPath(share.path), 'file');
      const body = `<section class="card"><p class="muted small">${esc(t.shared)}</p><div class="hero"><span class="ico">${svg(ICON.file, 24)}</span><div><h1>${esc(share.name)}</h1><div class="meta"><span>${bytes(file.stats.size, lang)}</span>${metaLine(share, t, lang)}</div></div></div>
<div class="actions"><a class="btn" href="${linkTo(token, '/f', null)}" download>${svg(ICON.download)}${esc(t.download)}</a></div></section>`;
      return sendHtml(reply, 200, { lang, title: share.name, body });
    }

    const segments = targetSegments(share, (request.query as { p?: unknown }).p);
    const listing = await listDirectory(lease.dataRoot, formatClientPath(segments), { limit: LIST_LIMIT });
    const rel = relOf(share, segments);
    const relParts = parseClientPath(rel);
    const crumbs = [`<a href="${linkTo(token, '', null)}">${esc(share.name)}</a>`];
    relParts.forEach((part, index) => {
      const href = linkTo(token, '', formatClientPath(relParts.slice(0, index + 1)));
      crumbs.push(index === relParts.length - 1 ? `<span>${esc(part)}</span>` : `<a href="${href}">${esc(part)}</a>`);
    });
    const rows = listing.entries.map((entry: FsEntry) => {
      const childRel = formatClientPath([...relParts, entry.name]);
      return entry.type === 'dir'
        ? `<li class="d"><a href="${linkTo(token, '', childRel)}"><span class="t">${svg(ICON.folder)}</span><span class="name">${esc(entry.name)}</span>${svg(ICON.chevron, 16)}</a></li>`
        : `<li><a href="${linkTo(token, '/f', childRel)}" download><span class="t">${svg(ICON.file)}</span><span class="name">${esc(entry.name)}</span><span class="size">${bytes(entry.size, lang)}</span>${svg(ICON.download, 16)}</a></li>`;
    });
    const title = relParts.at(-1) ?? share.name;
    const body = `<section class="card"><p class="muted small">${esc(t.shared)}</p><div class="hero"><span class="ico">${svg(ICON.folder, 24)}</span><div><h1>${esc(title)}</h1><div class="meta"><span>${esc(t.files(listing.total))}</span>${metaLine(share, t, lang)}</div></div></div>
${listing.total > 0 ? `<div class="actions"><a class="btn" href="${linkTo(token, '/zip', rel)}" download>${svg(ICON.download)}${esc(t.downloadAll)}</a></div>` : ''}</section>
<section class="card">${relParts.length > 0 ? `<nav class="crumbs" aria-label="${esc(t.folder)}">${crumbs.join(svg(ICON.chevron, 14))}</nav>` : ''}${rows.length > 0 ? `<ul>${rows.join('')}</ul>` : `<p class="muted">${esc(t.empty)}</p>`}${listing.total > listing.entries.length ? `<p class="muted small">${esc(t.more(listing.total - listing.entries.length))}</p>` : ''}</section>`;
    return sendHtml(reply, 200, { lang, title, body });
  });

  app.post('/s/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (share.passwordHash === null) return reply.status(303).header('location', `/s/${token}`).send();
    const now = Date.now();
    const ipKey = `${clientIp(request)}|${share.id}`;
    if (pinByIp.blocked(ipKey, now) || pinByShare.blocked(share.id, now) || verifying) throw new GuestHttpError(429, 'slow');
    const pin = (request.body as { pin?: unknown } | undefined)?.pin;
    if (typeof pin !== 'string' || pin.length === 0 || pin.length > 128) return lockedPage(request, reply, share, true);
    verifying = true; // Argon2id gasta ~64 MiB y ~0,5 s en la Pi: una verificación cada vez.
    let ok = false;
    try {
      ok = await verifyPassword(pin, share.passwordHash);
    } finally {
      verifying = false;
    }
    if (!ok) {
      pinByIp.take(ipKey, now);
      pinByShare.take(share.id, now);
      audit(db, { action: 'share.unlock', path: share.path, result: 'denied', ip: clientIp(request), detail: `enlace ${share.id}` }, clock());
      return lockedPage(request, reply, share, true);
    }
    const grant = randomBytes(24).toString('base64url');
    const expiresAt = Math.min(Date.parse(share.expiresAt), now + GRANT_TTL_MS);
    if (grants.size > 5000) for (const [key, value] of grants) if (value.expiresAt <= now) grants.delete(key);
    grants.set(sha(grant), { shareId: share.id, expiresAt });
    void reply.setCookie(GRANT_COOKIE, grant, {
      path: `/s/${token}`,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: Math.floor((expiresAt - now) / 1000),
    });
    return reply.status(303).header('location', `/s/${token}`).send();
  });

  /** Reserva un hueco de descarga; se libera al cerrarse la respuesta. */
  const reserve = (reply: FastifyReply): void => {
    if (downloading >= maxDownloads) throw new GuestHttpError(429, 'busy');
    downloading += 1;
    let released = false;
    reply.raw.once('close', () => {
      if (!released) downloading -= 1;
      released = true;
    });
  };

  /** Cuenta una descarga nueva y avisa si el enlace se ha agotado. */
  const countDownload = (request: FastifyRequest, share: ShareRow, what: string): void => {
    const fresh = store.get(share.id);
    if (fresh === null || stateOf(fresh, clock()) !== 'active') throw new GuestHttpError(404, 'gone');
    store.countDownload(share.id, clock());
    audit(db, { action: 'share.download', path: what, result: 'ok', ip: clientIp(request), detail: `enlace ${share.id}` }, clock());
    if (fresh.maxDownloads !== null && fresh.downloads + 1 >= fresh.maxDownloads) deps.onShareChanged?.();
  };

  app.get('/s/:token/f', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (!unlocked(request, share)) return lockedPage(request, reply, share, false);
    const lease = await guardian.assertReadableVolume();
    const segments = targetSegments(share, (request.query as { p?: unknown }).p);
    const file = await resolveInside(lease.dataRoot, segments, 'file');
    const size = file.stats.size;
    const name = segments.at(-1) ?? share.name;
    const etag = `"${size.toString(16)}-${Math.floor(file.stats.mtimeMs).toString(16)}"`;
    const ifRange = request.headers['if-range'];
    const range = ifRange !== undefined && ifRange !== etag ? null : parseRange(request.headers.range, size);
    if (range === 'unsatisfiable') return reply.status(416).header('content-range', `bytes */${size}`).send();

    reserve(reply);
    // Una descarga = una petición que empieza por el principio (las reanudaciones no cuentan).
    if (range === null || range.start === 0) countDownload(request, share, formatClientPath(segments));
    void reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', contentDisposition(name))
      .header('content-security-policy', "sandbox; default-src 'none'")
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('last-modified', new Date(file.stats.mtimeMs).toUTCString());
    const start = range === null ? 0 : range.start;
    const end = range === null ? size - 1 : range.end;
    if (range !== null) void reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`);
    void reply.header('content-length', size === 0 ? 0 : end - start + 1);
    if (size === 0) return reply.send('');
    const stream = createReadStream(file.abs, { start, end });
    stream.once('close', () => store.addBytes(share.id, stream.bytesRead));
    return reply.send(stream);
  });

  app.get('/s/:token/zip', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (share.kind !== 'dir') throw new GuestHttpError(404, 'notFound');
    if (!unlocked(request, share)) return lockedPage(request, reply, share, false);
    const lease = await guardian.assertReadableVolume();
    const segments = targetSegments(share, (request.query as { p?: unknown }).p);
    const plan = await planZip(lease.dataRoot, formatClientPath(segments), null, clock());
    reserve(reply);
    countDownload(request, share, formatClientPath(segments));
    let sent = 0;
    async function* counted(): AsyncGenerator<Buffer> {
      for await (const chunk of streamZip(plan)) {
        sent += chunk.length;
        yield chunk;
      }
    }
    const stream = Readable.from(counted());
    stream.once('close', () => store.addBytes(share.id, sent));
    stream.on('error', (error) => request.log.warn({ err: error }, 'ZIP de invitado interrumpido'));
    return reply
      .header('content-type', 'application/zip')
      .header('content-length', plan.length)
      .header('content-disposition', contentDisposition(plan.fileName))
      .header('content-security-policy', "sandbox; default-src 'none'")
      .send(stream);
  });

  return app;
}
