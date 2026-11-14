/**
 * Error de dominio con código estable de la API. La capa HTTP lo traduce a `ApiErrorBody`
 * (status según `API_ERROR_STATUS`); el resto del código no conoce HTTP.
 */

import type { ApiErrorCode } from '@pcloud/contracts';

export interface AppErrorOptions {
  readonly retryable?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ApiErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function errnoOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}
