import type { Translation } from '~/utils/i18n';
import type source from '../setup';

export default {
  pageTitle: 'Configurazione iniziale · Personal Cloud',
  title: 'Crea l’account del proprietario',
  lead: 'È l’account con accesso completo al tuo cloud. La password non può essere recuperata via email: conservala in un luogo sicuro.',
  code: 'Codice di configurazione',
  codeHelp: 'Codice monouso fornito dal server durante l’installazione (valido 24 h). Dimostra che hai accesso al Raspberry Pi.',
  username: 'Nome utente',
  usernameHelp: 'Lettere, numeri, punto, trattino e trattino basso.',
  password: 'Password',
  passwordHelp: 'Almeno {n} caratteri. Una frase facile da ricordare è più sicura di una parola con simboli.',
  repeat: 'Ripeti la password',
  mismatch: 'Le password non coincidono.',
  creating: 'Creazione dell’account…',
  submit: 'Crea account e accedi',
  failed: 'Impossibile creare l’account',
} satisfies Translation<typeof source>;
