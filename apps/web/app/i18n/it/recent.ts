import type { Translation } from '~/utils/i18n';
import type source from '../recent';

export default {
  title: 'Recenti',
  seeAll: 'Mostra tutti i file',
  unavailable: 'Impossibile mostrarli ora: il disco non è disponibile.',
  empty: 'Qui comparirà l’ultima cosa che carichi o crei.',
  goToFiles: 'Vai a File',
  openFolder: 'Apri cartella',
  openNamed: 'Apri «{name}»',
  downloadZip: 'Scarica come ZIP',
  download: 'Scarica',
} satisfies Translation<typeof source>;
