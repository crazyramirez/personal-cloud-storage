import type { Translation } from '~/utils/i18n';
import type source from '../auth';

export default {
  pageTitle: 'Accedi · Personal Cloud',
  title: 'Accedi',
  subtitle: 'Accedi al tuo cloud personale.',
  withPasskey: 'Accedi con una passkey',
  passkeyHint: 'Face ID, Touch ID, Windows Hello o l’impronta del tuo telefono.',
  orPassword: 'oppure con la password',
  username: 'Nome utente',
  password: 'Password',
  checking: 'Verifica in corso…',
  submit: 'Accedi',
  passkeyUnsupportedBefore: 'Per accedere con Face ID o Windows Hello, apri ',
  passkeyUnsupportedAfter: ' (non l’indirizzo IP) con il certificato installato.',
  loginFailed: 'Impossibile accedere',
  thisDevice: 'Questo dispositivo',
  cancelled: 'Operazione annullata',
  passkeyTimeout: 'La richiesta è stata annullata o è scaduta. Riprova.',
  passkeyExists: 'Questo dispositivo ha già una passkey registrata per il tuo account.',
  passkeyInsecure: 'Il browser non consente le passkey qui: apri l’app con il suo nome .local in HTTPS e con il certificato installato.',
  passkeyFailed: 'Impossibile completare la richiesta',
} satisfies Translation<typeof source>;
