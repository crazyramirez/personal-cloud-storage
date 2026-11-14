import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  image: 'Ver imagen',
  video: 'Reproducir vídeo',
  audio: 'Reproducir audio',
  pdf: 'Ver PDF',
  text: 'Ver texto',
  office: 'Ver documento',
  none: 'Ver detalles',
} satisfies MessageTable;

export default {
  es,
  en: {
    image: 'View image',
    video: 'Play video',
    audio: 'Play audio',
    pdf: 'View PDF',
    text: 'View text',
    office: 'View document',
    none: 'View details',
  } satisfies Record<keyof typeof es, Message>,
};
