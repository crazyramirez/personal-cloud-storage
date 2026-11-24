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
 *   GET  /s/<token>/ver?p=/a.jpg   ver un archivo de una carpeta en el navegador (ADR-0031)
 *   GET  /s/<token>/v[?p=]         el original para verlo (imagen, vídeo, audio, PDF, texto)
 *   GET  /s/<token>/img[?p=]       imagen convertida a JPEG (HEIC, TIFF, RAW…)
 *   GET  /s/<token>/doc[?p=]       documento de Office convertido a PDF
 *   GET  /s/<token>/stream[?p=]    vídeo o audio convertido al vuelo (MKV, AVI, HEVC…)
 *   GET  /og-image.jpg             imagen de la vista previa (WhatsApp, Telegram…)
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

import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
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
import { extensionOf, inlineContentType, needsImageConversion, viewerKind, type MediaInfo } from '../media/media.ts';
import type { MediaService } from '../media/service.ts';
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
  /** Visores (ffmpeg, LibreOffice). Sin ellos solo se ven los formatos que el navegador abre tal cual. */
  readonly media?: GuestMedia;
  /** Vistas simultáneas (imágenes, vídeos, documentos) en total. */
  readonly maxViews?: number;
}

export type GuestMedia = Pick<MediaService, 'resolve' | 'info' | 'stream' | 'image' | 'office' | 'capabilities'>;

/** Lo que se puede ver en el navegador desde un enlace (ADR-0031). */
type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'office' | 'text';
/** Imágenes que el navegador abre tal cual. SVG no: puede llevar código. */
const NATIVE_IMAGES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico']);
const TEXT_PREVIEW_MAX = 5 * 1024 * 1024;

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
    view: 'Ver',
    openFull: 'Abrir a pantalla completa',
    back: 'Volver a la carpeta',
    prev: 'Anterior',
    next: 'Siguiente',
    noPreview: 'Este archivo no se puede ver en el navegador: descárgalo para abrirlo.',
    slowFirst: 'La primera vez puede tardar un poco en prepararse.',
    playFallback: 'Si no se reproduce, descárgalo.',
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
    view: 'View',
    openFull: 'Open full screen',
    back: 'Back to the folder',
    prev: 'Previous',
    next: 'Next',
    noPreview: 'This file can’t be viewed in the browser: download it to open it.',
    slowFirst: 'The first time it may take a moment to get ready.',
    playFallback: 'If it doesn’t play, download it.',
  },
};
type Lang = keyof typeof TEXT;
type Texts = (typeof TEXT)[Lang];

/** Idioma del invitado. Sin cabecera (bots de vista previa), español: el idioma del propietario. */
function langOf(request: FastifyRequest): Lang {
  const header = String(request.headers['accept-language'] ?? '').trim();
  return header === '' || /^es\b/i.test(header) ? 'es' : 'en';
}

/** Imagen de la vista previa de los enlaces (1200×630, generada con GPT Image a partir del icono de la app). */
const OG_IMAGE = readFileSync(path.join(import.meta.dirname, 'og-image.jpg'));

/** Bots que generan la vista previa de un enlace al pegarlo en un chat (no buscadores). */
const PREVIEW_BOTS = /facebookexternalhit|WhatsApp|TelegramBot|Twitterbot|Slackbot|Discordbot|LinkedInBot|SkypeUriPreview|Signal|iMessage|Applebot|Google-PageRenderer/i;
const isPreviewBot = (request: FastifyRequest): boolean => PREVIEW_BOTS.test(String(request.headers['user-agent'] ?? ''));

/** Origen público (https://<host>-compartir.<tailnet>.ts.net) para las URL absolutas de og:image. */
function originOf(request: FastifyRequest): string | null {
  const host = String(request.headers['x-forwarded-host'] ?? request.headers.host ?? '').split(',')[0]?.trim() ?? '';
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return null;
  const forwarded = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  const proto = forwarded === 'http' || forwarded === 'https' ? forwarded : /\.ts\.net(:\d+)?$/i.test(host) ? 'https' : 'http';
  return `${proto}://${host.toLowerCase()}`;
}

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
  back: '<path d="m15 6-6 6 6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>',
  expand: '<path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="m20 4-7 7"/><path d="m4 20 7-7"/>',
};
const KIND_ICON: Record<PreviewKind, string> = { image: ICON.image, video: ICON.video, audio: ICON.audio, pdf: ICON.doc, office: ICON.doc, text: ICON.doc };

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
li{border-bottom:1px solid var(--border);display:flex;align-items:stretch}
li a{display:flex;align-items:center;gap:12px;padding:11px 4px;color:inherit;text-decoration:none;min-height:48px}
li a.row{flex:1;min-width:0}
li a.dl{flex:none;padding:0 12px;color:var(--muted)}
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
main.wide{max-width:1100px}
.btn.alt{background:var(--soft);color:var(--accent)}
.viewer{padding:0;overflow:hidden;background:#000;display:flex;justify-content:center}
.viewer.light{background:var(--surface);padding:16px}
.viewer img,.viewer video{display:block;max-width:100%;max-height:78vh;margin:auto}
.viewer video{width:100%}
.viewer audio{width:100%}
.viewer iframe{display:block;width:100%;height:78vh;border:0;background:#fff}
.pager{display:flex;justify-content:space-between;gap:10px}
.pager a{display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 14px;border-radius:10px;background:var(--surface);border:1px solid var(--border);color:var(--accent);text-decoration:none;font-weight:600;max-width:48%;overflow:hidden}
.pager a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pager .next{margin-left:auto}
footer{margin-top:auto;padding-top:28px;color:var(--muted);font-size:12px;text-align:center}
`;

interface PageInput {
  readonly lang: Lang;
  readonly title: string;
  readonly body: string;
  /** Texto de la vista previa (og:description). */
  readonly description?: string;
  /** Más ancho (visor de imágenes, vídeos y documentos). */
  readonly wide?: boolean;
}

/** Etiquetas Open Graph / Twitter: la tarjeta que se ve al pegar el enlace en un chat. */
function previewTags(input: PageInput, origin: string | null): string {
  const title = `${input.title} · Personal Cloud Storage`;
  const description = input.description ?? TEXT[input.lang].footer;
  const image = origin === null ? null : `${origin}/og-image.jpg`;
  const properties: Array<[string, string]> = [
    ['og:type', 'website'],
    ['og:site_name', 'Personal Cloud Storage'],
    ['og:title', title],
    ['og:description', description],
    ['og:locale', input.lang === 'es' ? 'es_ES' : 'en_US'],
  ];
  if (image !== null) {
    properties.push(['og:image', image], ['og:image:secure_url', image], ['og:image:type', 'image/jpeg'], ['og:image:width', '1200'], ['og:image:height', '630'], ['og:image:alt', 'Personal Cloud Storage']);
  }
  const names: Array<[string, string]> = [
    ['description', description],
    ['twitter:card', image === null ? 'summary' : 'summary_large_image'],
    ['twitter:title', title],
    ['twitter:description', description],
  ];
  if (image !== null) names.push(['twitter:image', image]);
  return [
    ...properties.map(([property, content]) => `<meta property="${property}" content="${esc(content)}">`),
    ...names.map(([name, content]) => `<meta name="${name}" content="${esc(content)}">`),
  ].join('');
}

function page(input: PageInput, nonce: string, origin: string | null): string {
  const { lang, title, body } = input;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#0f1115"><title>${esc(title)}</title>${previewTags(input, origin)}<style nonce="${nonce}">${STYLE}</style></head><body><main${input.wide === true ? ' class="wide"' : ''}><div class="brand">${svg(ICON.cloud, 18)}Personal Cloud Storage</div>${body}</main><footer>${esc(TEXT[lang].footer)}</footer></body></html>`;
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
  const origins = new WeakMap<FastifyReply, string | null>();

  app.addHook('onRequest', async (request, reply) => {
    const nonce = randomBytes(16).toString('base64');
    (reply as unknown as { pcloudNonce: string }).pcloudNonce = nonce;
    origins.set(reply, originOf(request));
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
    reply.status(status).header('content-type', 'text/html; charset=utf-8').send(page(input, nonceOf(reply), origins.get(reply) ?? null));

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
    const hint = { gone: t.goneHint, moved: t.movedHint, offline: t.offlineHint, busy: t.busyHint, slow: t.slowHint, notFound: t.goneHint }[failure.kind];
    return sendHtml(reply, failure.status, { lang, title, body: card, description: hint });
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
    // La vista previa de un enlace con contraseña no revela el nombre de lo compartido.
    return sendHtml(reply, status, { lang, title: t.locked, body, description: t.lockedHint });
  };

  const metaLine = (share: ShareRow, t: Texts, lang: Lang): string => {
    const parts = [esc(t.until.replace('{date}', when(share.expiresAt, lang)))];
    if (share.maxDownloads !== null) parts.push(esc(t.left(Math.max(0, share.maxDownloads - share.downloads))));
    return parts.map((part) => `<span>${part}</span>`).join('');
  };

  // ── Ver en el navegador (ADR-0031) ──────────────────────────────────────────────────────────

  /**
   * Cómo se puede ver un archivo en el navegador, solo por su nombre y tamaño (sin leerlo).
   * null = solo descargar. Con límite de descargas no hay vista: verlo ya sería descargarlo.
   */
  const previewKind = (share: ShareRow, name: string, size: number): PreviewKind | null => {
    if (share.maxDownloads !== null) return null;
    const tools = deps.media?.capabilities;
    const ext = extensionOf(name);
    switch (viewerKind(name)) {
      case 'image':
        return NATIVE_IMAGES.has(ext) || (needsImageConversion(name) && tools?.ffmpeg === true) ? 'image' : null;
      case 'pdf':
        return 'pdf';
      case 'text':
        return size <= TEXT_PREVIEW_MAX ? 'text' : null;
      case 'office':
        return tools?.office === true ? 'office' : null;
      case 'video':
      case 'audio':
        return inlineContentType(name) !== null || tools?.ffmpeg === true ? (viewerKind(name) as 'video' | 'audio') : null;
      default:
        return null;
    }
  };

  /** Vistas simultáneas (aparte de las descargas: un vídeo abre a veces dos conexiones). */
  const maxViews = deps.maxViews ?? 8;
  let viewing = 0;
  const reserveView = (reply: FastifyReply): void => {
    if (viewing >= maxViews) throw new GuestHttpError(429, 'busy');
    viewing += 1;
    let released = false;
    reply.raw.once('close', () => {
      if (!released) viewing -= 1;
      released = true;
    });
  };

  /** CSP de la página del visor: además de su estilo, imágenes, vídeo y marcos de su mismo origen. */
  const viewerCsp = (reply: FastifyReply): string =>
    `default-src 'none'; style-src 'nonce-${nonceOf(reply)}'; img-src 'self' data:; media-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`;

  /**
   * Fuentes del reproductor. Sin JavaScript, el navegador elige la primera que sabe reproducir:
   * el original si lo entiende (también HEVC en Safari o con aceleración) y, si no, la versión
   * que convierte el servidor. null = no se puede reproducir.
   */
  const mediaSources = async (token: string, rel: string | null, segments: readonly string[], name: string): Promise<string | null> => {
    const native = inlineContentType(name);
    const direct = linkTo(token, '/v', rel);
    const converted = linkTo(token, '/stream', rel);
    const source = (src: string, type: string): string => `<source src="${src}" type="${esc(type)}">`;
    let info: MediaInfo | null = null;
    if (deps.media !== undefined && deps.media.capabilities.ffmpeg) {
      info = await deps.media.resolve(formatClientPath(segments)).then((file) => deps.media?.info(file) ?? null).catch(() => null);
    }
    if (info === null) return native === null ? null : source(direct, native);
    if (info.playback === 'none') return null;
    if (info.playback === 'direct' && native !== null) return source(direct, native);
    return (info.directType !== null && native !== null ? source(direct, info.directType) : '') + source(converted, 'video/mp4');
  };

  /** Página para ver un archivo: el visor, descargar y, en carpetas, anterior y siguiente. */
  const viewerPage = async (request: FastifyRequest, reply: FastifyReply, share: ShareRow, segments: string[], size: number, dataRoot: string): Promise<FastifyReply> => {
    const lang = langOf(request);
    const t = TEXT[lang];
    const token = (request.params as { token: string }).token;
    const name = segments.at(-1) ?? share.name;
    const inFolder = share.kind === 'dir';
    const rel = inFolder ? relOf(share, segments) : null;
    let kind = previewKind(share, name, size);

    let view = '';
    let fullScreen: string | null = null;
    if (kind === 'image') {
      const src = linkTo(token, needsImageConversion(name) ? '/img' : '/v', rel);
      view = `<section class="card viewer"><img src="${src}" alt="${esc(name)}"></section>`;
    } else if (kind === 'video' || kind === 'audio') {
      const sources = await mediaSources(token, rel, segments, name);
      if (sources === null) kind = null;
      else if (kind === 'video') view = `<section class="card viewer"><video controls playsinline preload="metadata">${sources}</video></section>`;
      else view = `<section class="card viewer light"><audio controls preload="metadata">${sources}</audio></section>`;
    } else if (kind === 'pdf' || kind === 'office' || kind === 'text') {
      fullScreen = linkTo(token, kind === 'office' ? '/doc' : '/v', rel);
      // El texto, en un marco aislado; el PDF no se puede aislar (el visor del navegador no abriría).
      view = `<section class="card viewer"><iframe src="${fullScreen}" title="${esc(name)}"${kind === 'text' ? ' sandbox' : ''}></iframe></section>`;
    }

    const crumbs: string[] = [];
    let backLink: string | null = null;
    let pager = '';
    if (inFolder) {
      const relParts = parseClientPath(rel ?? '/');
      crumbs.push(`<a href="${linkTo(token, '', null)}">${esc(share.name)}</a>`);
      relParts.forEach((part, index) => {
        const href = linkTo(token, '', formatClientPath(relParts.slice(0, index + 1)));
        crumbs.push(index === relParts.length - 1 ? `<span>${esc(part)}</span>` : `<a href="${href}">${esc(part)}</a>`);
      });
      const parentRel = formatClientPath(relParts.slice(0, -1));
      backLink = linkTo(token, '', parentRel);
      // Anterior y siguiente: los archivos que se pueden ver de la misma carpeta, en su orden.
      const siblings = await listDirectory(dataRoot, formatClientPath(segments.slice(0, -1)), { limit: LIST_LIMIT }).catch(() => null);
      const viewable = (siblings?.entries ?? []).filter((entry) => entry.type === 'file' && previewKind(share, entry.name, entry.size) !== null);
      const at = viewable.findIndex((entry) => entry.name === name);
      const link = (entry: FsEntry | undefined, which: 'prev' | 'next'): string =>
        entry === undefined
          ? ''
          : `<a class="${which}" href="${linkTo(token, '/ver', formatClientPath([...relParts.slice(0, -1), entry.name]))}" title="${esc(entry.name)}">${which === 'prev' ? svg(ICON.back, 18) : ''}<span>${esc(t[which])}</span>${which === 'next' ? svg(ICON.chevron, 18) : ''}</a>`;
      if (at !== -1 && viewable.length > 1) pager = `<nav class="pager" aria-label="${esc(t.folder)}">${link(viewable[at - 1], 'prev')}${link(viewable[at + 1], 'next')}</nav>`;
    }

    const actions = [
      `<a class="btn" href="${linkTo(token, '/f', rel)}" download>${svg(ICON.download)}${esc(t.download)}</a>`,
      ...(fullScreen === null ? [] : [`<a class="btn alt" href="${fullScreen}">${svg(ICON.expand)}${esc(t.openFull)}</a>`]),
      ...(backLink === null ? [] : [`<a class="btn alt" href="${backLink}">${svg(ICON.back)}${esc(t.back)}</a>`]),
    ];
    const note = kind === null ? t.noPreview : kind === 'office' || (kind === 'image' && needsImageConversion(name)) ? t.slowFirst : kind === 'video' ? t.playFallback : null;
    const body = `<section class="card">${crumbs.length > 0 ? `<nav class="crumbs" aria-label="${esc(t.folder)}">${crumbs.join(svg(ICON.chevron, 14))}</nav>` : `<p class="muted small">${esc(t.shared)}</p>`}<div class="hero"><span class="ico">${svg(kind === null ? ICON.file : KIND_ICON[kind], 24)}</span><div><h1>${esc(name)}</h1><div class="meta"><span>${bytes(size, lang)}</span>${metaLine(share, t, lang)}</div></div></div>
<div class="actions">${actions.join('')}</div>${note === null ? '' : `<p class="muted small note">${esc(note)}</p>`}</section>${view}${pager}`;
    if (kind !== null && !isPreviewBot(request)) {
      audit(db, { action: 'share.view', path: formatClientPath(segments), result: 'ok', ip: clientIp(request), detail: `enlace ${share.id}` }, clock());
    }
    reply.header('content-security-policy', viewerCsp(reply));
    return sendHtml(reply, 200, { lang, title: name, body, wide: kind !== null, description: `${t.shared} · ${bytes(size, lang)} · ${t.until.replace('{date}', when(share.expiresAt, lang))}` });
  };

  /**
   * Archivo pedido para verlo, si su tipo está entre los permitidos para esa ruta. Cualquier otra
   * cosa (otro tipo, enlace con límite de descargas, SVG…) es «no encontrado».
   */
  const viewTarget = async (request: FastifyRequest, allowed: readonly PreviewKind[]): Promise<{ share: ShareRow; segments: string[]; name: string; abs: string; size: number; mtimeMs: number } | 'locked'> => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (!unlocked(request, share)) return 'locked';
    const lease = await guardian.assertReadableVolume();
    const segments = targetSegments(share, (request.query as { p?: unknown }).p);
    const file = await resolveInside(lease.dataRoot, segments, 'file');
    const name = segments.at(-1) ?? share.name;
    const kind = previewKind(share, name, file.stats.size);
    if (kind === null || !allowed.includes(kind)) throw new GuestHttpError(404, 'notFound');
    return { share, segments, name, abs: file.abs, size: file.stats.size, mtimeMs: file.stats.mtimeMs };
  };

  /** Lo que se ve dentro del visor puede ir en un marco de la propia puerta, nunca de otra web. */
  const frameable = (reply: FastifyReply, csp: string): FastifyReply => reply.header('x-frame-options', 'SAMEORIGIN').header('content-security-policy', csp);

  // ── Rutas ────────────────────────────────────────────────────────────────────────────────

  // Los buscadores no entran; los bots de vista previa de los chats sí (sin ellos no hay tarjeta).
  const ROBOTS = [
    'User-agent: facebookexternalhit',
    'User-agent: WhatsApp',
    'User-agent: TelegramBot',
    'User-agent: Twitterbot',
    'User-agent: Slackbot-LinkExpanding',
    'User-agent: Discordbot',
    'User-agent: LinkedInBot',
    'Allow: /s/',
    'Allow: /og-image.jpg',
    '',
    'User-agent: *',
    'Disallow: /',
    '',
  ].join('\n');
  app.get('/robots.txt', async (_request, reply) => reply.header('content-type', 'text/plain; charset=utf-8').send(ROBOTS));

  app.get('/og-image.jpg', async (_request, reply) =>
    reply
      .header('content-type', 'image/jpeg')
      .header('content-length', OG_IMAGE.length)
      .header('cache-control', 'public, max-age=604800')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(OG_IMAGE),
  );

  app.get('/s/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (!unlocked(request, share)) return lockedPage(request, reply, share, false);
    const lang = langOf(request);
    const t = TEXT[lang];
    const lease = await guardian.assertReadableVolume();
    // Que WhatsApp o Telegram generen la vista previa no es que alguien lo haya abierto.
    if (!isPreviewBot(request)) store.touch(share, clock());

    if (share.kind === 'file') {
      const file = await resolveInside(lease.dataRoot, parseClientPath(share.path), 'file');
      if (previewKind(share, share.name, file.stats.size) !== null) return viewerPage(request, reply, share, parseClientPath(share.path), file.stats.size, lease.dataRoot);
      const body = `<section class="card"><p class="muted small">${esc(t.shared)}</p><div class="hero"><span class="ico">${svg(ICON.file, 24)}</span><div><h1>${esc(share.name)}</h1><div class="meta"><span>${bytes(file.stats.size, lang)}</span>${metaLine(share, t, lang)}</div></div></div>
<div class="actions"><a class="btn" href="${linkTo(token, '/f', null)}" download>${svg(ICON.download)}${esc(t.download)}</a></div></section>`;
      return sendHtml(reply, 200, { lang, title: share.name, body, description: `${t.shared} · ${bytes(file.stats.size, lang)} · ${t.until.replace('{date}', when(share.expiresAt, lang))}` });
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
      if (entry.type === 'dir') {
        return `<li class="d"><a class="row" href="${linkTo(token, '', childRel)}"><span class="t">${svg(ICON.folder)}</span><span class="name">${esc(entry.name)}</span>${svg(ICON.chevron, 16)}</a></li>`;
      }
      const kind = previewKind(share, entry.name, entry.size);
      // Lo que se puede ver se abre en el visor; el botón de la derecha descarga.
      return kind === null
        ? `<li><a class="row" href="${linkTo(token, '/f', childRel)}" download><span class="t">${svg(ICON.file)}</span><span class="name">${esc(entry.name)}</span><span class="size">${bytes(entry.size, lang)}</span>${svg(ICON.download, 16)}</a></li>`
        : `<li><a class="row" href="${linkTo(token, '/ver', childRel)}"><span class="t">${svg(KIND_ICON[kind])}</span><span class="name">${esc(entry.name)}</span><span class="size">${bytes(entry.size, lang)}</span></a><a class="dl" href="${linkTo(token, '/f', childRel)}" download aria-label="${esc(`${t.download}: ${entry.name}`)}" title="${esc(t.download)}">${svg(ICON.download, 16)}</a></li>`;
    });
    const title = relParts.at(-1) ?? share.name;
    const body = `<section class="card"><p class="muted small">${esc(t.shared)}</p><div class="hero"><span class="ico">${svg(ICON.folder, 24)}</span><div><h1>${esc(title)}</h1><div class="meta"><span>${esc(t.files(listing.total))}</span>${metaLine(share, t, lang)}</div></div></div>
${listing.total > 0 ? `<div class="actions"><a class="btn" href="${linkTo(token, '/zip', rel)}" download>${svg(ICON.download)}${esc(t.downloadAll)}</a></div>` : ''}</section>
<section class="card">${relParts.length > 0 ? `<nav class="crumbs" aria-label="${esc(t.folder)}">${crumbs.join(svg(ICON.chevron, 14))}</nav>` : ''}${rows.length > 0 ? `<ul>${rows.join('')}</ul>` : `<p class="muted">${esc(t.empty)}</p>`}${listing.total > listing.entries.length ? `<p class="muted small">${esc(t.more(listing.total - listing.entries.length))}</p>` : ''}</section>`;
    return sendHtml(reply, 200, { lang, title, body, description: `${t.folder} · ${t.shared} · ${t.files(listing.total)} · ${t.until.replace('{date}', when(share.expiresAt, lang))}` });
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
      .header('content-security-policy', "sandbox; default-src 'none'");
    return sendBytes(reply, share, file.abs, size, file.stats.mtimeMs, range, etag);
  });

  /** Envía el archivo (entero o el rango pedido) y suma los bytes al enlace. */
  const sendBytes = (reply: FastifyReply, share: ShareRow, abs: string, size: number, mtimeMs: number, range: { start: number; end: number } | null, etag: string): FastifyReply => {
    void reply.header('accept-ranges', 'bytes').header('etag', etag).header('last-modified', new Date(mtimeMs).toUTCString());
    const start = range === null ? 0 : range.start;
    const end = range === null ? size - 1 : range.end;
    if (range !== null) void reply.status(206).header('content-range', `bytes ${start}-${end}/${size}`);
    void reply.header('content-length', size === 0 ? 0 : end - start + 1);
    if (size === 0) return reply.send('');
    const stream = createReadStream(abs, { start, end });
    stream.once('close', () => store.addBytes(share.id, stream.bytesRead));
    return reply.send(stream);
  };

  app.get('/s/:token/ver', async (request, reply) => {
    const { token } = request.params as { token: string };
    const share = activeShare(token);
    if (share.kind !== 'dir') return reply.status(303).header('location', `/s/${token}`).send();
    if (!unlocked(request, share)) return lockedPage(request, reply, share, false);
    const lease = await guardian.assertReadableVolume();
    const segments = targetSegments(share, (request.query as { p?: unknown }).p);
    const file = await resolveInside(lease.dataRoot, segments, 'file');
    if (!isPreviewBot(request)) store.touch(share, clock());
    return viewerPage(request, reply, share, segments, file.stats.size, lease.dataRoot);
  });

  // El original, para verlo: imagen del navegador, vídeo o audio que entiende, PDF o texto.
  // Ver no cuenta como descarga (los enlaces con límite de descargas no tienen vista).
  app.get('/s/:token/v', async (request, reply) => {
    const target = await viewTarget(request, ['image', 'video', 'audio', 'pdf', 'text']);
    if (target === 'locked') return reply.status(401).send();
    const { share, name, abs, size, mtimeMs } = target;
    const type = inlineContentType(name);
    if (type === null || needsImageConversion(name)) throw new GuestHttpError(404, 'notFound');
    const etag = `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
    const ifRange = request.headers['if-range'];
    const range = ifRange !== undefined && ifRange !== etag ? null : parseRange(request.headers.range, size);
    if (range === 'unsatisfiable') return reply.status(416).header('content-range', `bytes */${size}`).send();
    reserveView(reply);
    // El visor de PDF del navegador no abre en un documento aislado (sandbox); el resto, sí.
    frameable(reply, type === 'application/pdf' ? "frame-ancestors 'self'" : "sandbox; default-src 'none'; frame-ancestors 'self'");
    void reply.header('content-type', type).header('content-disposition', contentDisposition(name, true));
    return sendBytes(reply, share, abs, size, mtimeMs, range, etag);
  });

  // Imágenes que el navegador no abre (HEIC, TIFF, RAW…), convertidas a JPEG por el servidor.
  app.get('/s/:token/img', async (request, reply) => {
    const media = deps.media;
    const target = await viewTarget(request, ['image']);
    if (target === 'locked') return reply.status(401).send();
    if (media === undefined || !needsImageConversion(target.name)) throw new GuestHttpError(404, 'notFound');
    reserveView(reply);
    const served = await media.image(await media.resolve(formatClientPath(target.segments)));
    store.addBytes(target.share.id, served.size);
    frameable(reply, "sandbox; default-src 'none'; frame-ancestors 'self'");
    void reply.header('content-type', 'image/jpeg').header('content-length', served.size).header('content-disposition', contentDisposition(`${target.name}.jpg`, true));
    return reply.send(served.file !== undefined ? createReadStream(served.file) : served.buffer);
  });

  // Documentos de Office, como PDF (LibreOffice; se guarda en la caché del disco de datos).
  app.get('/s/:token/doc', async (request, reply) => {
    const media = deps.media;
    const target = await viewTarget(request, ['office']);
    if (target === 'locked') return reply.status(401).send();
    if (media === undefined) throw new GuestHttpError(404, 'notFound');
    reserveView(reply);
    const served = await media.office(await media.resolve(formatClientPath(target.segments)));
    store.addBytes(target.share.id, served.size);
    frameable(reply, "frame-ancestors 'self'");
    void reply.header('content-type', 'application/pdf').header('content-length', served.size).header('content-disposition', contentDisposition(`${target.name}.pdf`, true));
    return reply.send(served.file !== undefined ? createReadStream(served.file) : served.buffer);
  });

  // Vídeo o audio que el navegador no entiende, convertido al vuelo (mismo límite que la app).
  app.get('/s/:token/stream', async (request, reply) => {
    const media = deps.media;
    const target = await viewTarget(request, ['video', 'audio']);
    if (target === 'locked') return reply.status(401).send();
    if (media === undefined || !media.capabilities.ffmpeg) throw new GuestHttpError(404, 'notFound');
    const started = await media.stream(await media.resolve(formatClientPath(target.segments)), 0);
    if (started === null) throw new GuestHttpError(429, 'busy');
    const { child } = started;
    const stop = (): void => {
      if (child.exitCode === null) child.kill('SIGKILL');
    };
    request.raw.once('close', stop);
    reply.raw.once('close', stop);
    child.once('error', (error) => {
      request.log.warn({ err: error }, 'no se pudo lanzar ffmpeg para un invitado');
      if (!reply.sent) void reply.status(503).send();
    });
    child.stderr.resume();
    let sent = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      sent += chunk.length;
    });
    child.stdout.once('close', () => store.addBytes(target.share.id, sent));
    frameable(reply, "sandbox; default-src 'none'; frame-ancestors 'self'");
    return reply.header('content-type', 'video/mp4').send(child.stdout);
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
