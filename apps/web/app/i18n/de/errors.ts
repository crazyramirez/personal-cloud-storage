import type { Translation } from '~/utils/i18n';
import type source from '../errors';

export default {
  VALIDATION_FAILED: 'Die Anfrage ist ungültig',
  INVALID_PATH: 'Der Pfad ist ungültig',
  INVALID_NAME: 'Der Name ist ungültig',
  UNAUTHENTICATED: 'Ihre Sitzung ist abgelaufen: Bitte melden Sie sich erneut an',
  FORBIDDEN: 'Sie sind dazu nicht berechtigt',
  NOT_FOUND: 'Existiert nicht (wurde möglicherweise verschoben oder gelöscht)',
  CONFLICT: 'Steht im Konflikt mit etwas, das bereits existiert',
  OFFSET_MISMATCH: 'Der Upload ist nicht mehr synchron; er wird fortgesetzt',
  PRECONDITION_FAILED: 'Das Element hat sich inzwischen geändert',
  PAYLOAD_TOO_LARGE: 'Zu groß',
  UNSUPPORTED_MEDIA: 'Dieser Dateityp kann nicht angezeigt werden',
  RANGE_NOT_SATISFIABLE: 'Ungültiger Bereich angefordert',
  CHECKSUM_MISMATCH: 'Die Datei ist beschädigt angekommen; der Upload wird wiederholt',
  LOCKED: 'Wird von einem anderen Vorgang verwendet',
  RATE_LIMITED: 'Zu viele Versuche: Bitte warten Sie einen Moment',
  INTERNAL: 'Interner Serverfehler',
  STORAGE_UNAVAILABLE: 'Die Festplatte ist nicht verfügbar',
  INSUFFICIENT_STORAGE: 'Die Festplatte ist voll',
  NETWORK: 'Server nicht erreichbar',
  TIMEOUT: 'Der Server antwortet nicht. Versuchen Sie es in einigen Sekunden erneut.',
  httpStatus: 'Fehler {status}',
} satisfies Translation<typeof source>;
