import type { Translation } from '~/utils/i18n';
import type source from '../pairing';

export default {
  title: 'Backup dei tuoi computer',
  intro: 'I tuoi computer possono salvare il loro backup nel cloud con DEV Backup Studio. Si collegano con un codice, senza digitare password.',
  connect: 'Collega un computer',
  newCode: 'Un altro codice',
  cancel: 'Annulla',
  codeLabel: 'Codice per collegarsi',
  step1: 'Sul computer, apri DEV Backup Studio.',
  step2: 'Premi «Connetti al mio cloud».',
  step3: 'Digita questo codice.',
  expires: ({ min }) => `Scade tra ${min} min e si può usare una sola volta.`,
  expired: 'Il codice è scaduto.',
  where: ({ host, share }) => `I backup vengono salvati nella cartella «${share}» del cloud (\\\\${host}\\${share}).`,
  unavailable: 'La cartella di rete non è installata su questo dispositivo. Per attivarla, esegui sul server: sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: 'Impossibile creare il codice',
  copied: 'Codice copiato',
  copy: 'Copia codice',
} satisfies Translation<typeof source>;
