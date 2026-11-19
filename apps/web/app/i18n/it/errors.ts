import type { Translation } from '~/utils/i18n';
import type source from '../errors';

export default {
  VALIDATION_FAILED: 'La richiesta non è valida',
  INVALID_PATH: 'Il percorso non è valido',
  INVALID_NAME: 'Il nome non è valido',
  UNAUTHENTICATED: 'La sessione è scaduta: accedi di nuovo',
  FORBIDDEN: 'Non hai l’autorizzazione per farlo',
  NOT_FOUND: 'Non esiste (potrebbe essere stato spostato o eliminato)',
  CONFLICT: 'È in conflitto con qualcosa che esiste già',
  OFFSET_MISMATCH: 'Il caricamento non è più sincronizzato; riprenderà',
  PRECONDITION_FAILED: 'L’elemento è stato modificato nel frattempo',
  PAYLOAD_TOO_LARGE: 'È troppo grande',
  UNSUPPORTED_MEDIA: 'Impossibile mostrare questo tipo di file',
  RANGE_NOT_SATISFIABLE: 'Intervallo richiesto non valido',
  CHECKSUM_MISMATCH: 'Il file è arrivato danneggiato; il caricamento verrà ripetuto',
  LOCKED: 'È in uso da parte di un’altra operazione',
  RATE_LIMITED: 'Troppi tentativi: attendi un momento',
  INTERNAL: 'Errore interno del server',
  STORAGE_UNAVAILABLE: 'Il disco non è disponibile',
  INSUFFICIENT_STORAGE: 'Il disco è pieno',
  NETWORK: 'Impossibile contattare il server',
  TIMEOUT: 'Il server non risponde. Riprova tra qualche secondo.',
  httpStatus: 'Errore {status}',
} satisfies Translation<typeof source>;
