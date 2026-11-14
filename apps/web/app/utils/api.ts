/**
 * Cliente mínimo de la API v1. Mismo origen (cookie de sesión HttpOnly); toda petición que
 * modifica estado lleva la cabecera anti-CSRF que exige el servidor.
 */

import type { ApiErrorBody } from '@pcloud/contracts';

const BASE = '/api/v1';
/** Debe coincidir con CSRF_HEADER de @pcloud/contracts (no se importa para no empaquetar los esquemas). */
const CSRF_HEADER = 'x-pcloud-request';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  /** `message` puede ser una función: se evalúa al leerlo, en el idioma activo en ese momento. */
  constructor(code: string, message: string | (() => string), status: number, retryable: boolean, details: Record<string, unknown> = {}) {
    super(typeof message === 'function' ? message() : message);
    if (typeof message === 'function') Object.defineProperty(this, 'message', { get: message, enumerable: false, configurable: true });
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Cuerpo JSON. */
  body?: unknown;
  /** Cuerpo binario (bloques de subida). */
  raw?: Blob;
  query?: Record<string, string | number | null | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** false: un 401 no dispara la redirección al inicio de sesión (comprobaciones silenciosas). */
  handle401?: boolean;
  /** Tiempo máximo de espera (ms). 0 = sin límite (operaciones largas: copiar, mover…). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;

let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export async function apiResponse(path: string, options: ApiOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET';
  const url = new URL(`${BASE}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = { ...options.headers };
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  let body: BodyInit | undefined;
  if (options.raw !== undefined) {
    body = options.raw;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  // Nunca se espera indefinidamente: si el servidor no contesta, se avisa y se puede reintentar.
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
  const signal = timeout === null ? options.signal : options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let response: Response;
  try {
    response = await fetch(url, { method, headers, body, credentials: 'same-origin', signal, cache: 'no-store' });
  } catch (error) {
    if (options.signal?.aborted === true) throw error;
    if (timeout?.aborted === true) throw new ApiError('TIMEOUT', () => t('errors.TIMEOUT'), 0, true);
    throw new ApiError('NETWORK', () => t('errors.NETWORK'), 0, true);
  }
  if (response.ok) return response;

  const data = (await response.json().catch(() => null)) as ApiErrorBody | null;
  const code = data?.error.code ?? 'INTERNAL';
  // El servidor redacta en español (mensajes concretos); en otro idioma se usa el texto por código.
  const serverMessage = data?.error.message ?? '';
  const failure = new ApiError(
    code,
    () => (serverMessage === '' ? t('errors.httpStatus', { status: response.status }) : localizeServerError(code, serverMessage)),
    response.status,
    data?.error.retryable ?? response.status >= 500,
    (data?.error.details as Record<string, unknown> | undefined) ?? {},
  );
  if (response.status === 401 && options.handle401 !== false) unauthorizedHandler?.();
  throw failure;
}

/** Códigos cuyo significado es único: su texto genérico nunca contradice al del servidor. */
const UNAMBIGUOUS = new Set(['STORAGE_UNAVAILABLE', 'INSUFFICIENT_STORAGE', 'RATE_LIMITED', 'INTERNAL', 'OFFSET_MISMATCH', 'CHECKSUM_MISMATCH', 'RANGE_NOT_SATISFIABLE', 'LOCKED']);

/**
 * Mensaje de error en el idioma activo: el texto concreto del servidor traducido; si no se conoce,
 * el genérico del código solo cuando es inequívoco; si no, el original del servidor.
 */
export function localizeServerError(code: string, message: string): string {
  if (locale.value === 'es') return message;
  if (hasServerText(message)) return serverText(message);
  if (UNAMBIGUOUS.has(code) && hasMessage(`errors.${code}`)) return t(`errors.${code}`);
  return message;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await apiResponse(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** URL de descarga directa: el navegador gestiona la descarga (y su reanudación con Range). */
export function downloadUrl(clientPath: string): string {
  return `${BASE}/fs/download?path=${encodeURIComponent(clientPath)}`;
}

/** Mismo archivo, para mostrarlo en el navegador (solo tipos seguros; el resto se descarga). */
export function inlineUrl(clientPath: string): string {
  return `${downloadUrl(clientPath)}&inline=1`;
}

/** ZIP de una carpeta completa (`names` vacío) o de elementos de esa carpeta. */
export function zipUrl(dir: string, names: readonly string[] = []): string {
  const query = new URLSearchParams({ dir });
  if (names.length > 0) query.set('names', names.join('/'));
  return `${BASE}/fs/zip?${query.toString()}`;
}

export function thumbUrl(clientPath: string, size = 320, version = ''): string {
  return `${BASE}/preview/thumb?path=${encodeURIComponent(clientPath)}&size=${size}${version === '' ? '' : `&v=${encodeURIComponent(version)}`}`;
}

export function convertedImageUrl(clientPath: string): string {
  return `${BASE}/preview/image?path=${encodeURIComponent(clientPath)}`;
}

export function documentPdfUrl(clientPath: string): string {
  return `${BASE}/preview/document?path=${encodeURIComponent(clientPath)}`;
}

export function streamUrl(clientPath: string, start = 0): string {
  return `${BASE}/media/stream?path=${encodeURIComponent(clientPath)}${start > 0 ? `&t=${start.toFixed(2)}` : ''}`;
}

