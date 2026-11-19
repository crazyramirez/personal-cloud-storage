import type { Translation } from '~/utils/i18n';
import type source from '../viewers';

export default {
  image: 'Voir l’image',
  video: 'Lire la vidéo',
  audio: 'Lire l’audio',
  pdf: 'Voir le PDF',
  text: 'Voir le texte',
  office: 'Voir le document',
  none: 'Voir les détails',
} satisfies Translation<typeof source>;
