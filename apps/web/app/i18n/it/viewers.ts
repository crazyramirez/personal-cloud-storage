import type { Translation } from '~/utils/i18n';
import type source from '../viewers';

export default {
  image: 'Visualizza immagine',
  video: 'Riproduci video',
  audio: 'Riproduci audio',
  pdf: 'Visualizza PDF',
  text: 'Visualizza testo',
  office: 'Visualizza documento',
  none: 'Mostra dettagli',
} satisfies Translation<typeof source>;
