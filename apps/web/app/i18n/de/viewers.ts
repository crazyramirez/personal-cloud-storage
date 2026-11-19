import type { Translation } from '~/utils/i18n';
import type source from '../viewers';

export default {
  image: 'Bild ansehen',
  video: 'Video abspielen',
  audio: 'Audio abspielen',
  pdf: 'PDF ansehen',
  text: 'Text ansehen',
  office: 'Dokument ansehen',
  none: 'Details ansehen',
} satisfies Translation<typeof source>;
