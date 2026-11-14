/**
 * Modelo de error estándar de la API v1 (spec §8).
 */

export const API_ERROR_STATUS = {
  VALIDATION_FAILED: 400,
  INVALID_PATH: 400,
  INVALID_NAME: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OFFSET_MISMATCH: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA: 415,
  RANGE_NOT_SATISFIABLE: 416,
  CHECKSUM_MISMATCH: 422,
  LOCKED: 423,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  STORAGE_UNAVAILABLE: 503,
  INSUFFICIENT_STORAGE: 507,
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_STATUS;

export interface ApiErrorBody {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}
