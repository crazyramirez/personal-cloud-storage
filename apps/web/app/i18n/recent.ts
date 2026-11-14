import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  title: 'Recientes',
  seeAll: 'Ver todos los archivos',
  unavailable: 'No se pueden mostrar ahora: el disco no está disponible.',
  empty: 'Aquí aparecerá lo último que subas o crees.',
  goToFiles: 'Ir a Archivos',
  openFolder: 'Abrir carpeta',
  openNamed: 'Abrir «{name}»',
  downloadZip: 'Descargar como ZIP',
  download: 'Descargar',
} satisfies MessageTable;

export default {
  es,
  en: {
    title: 'Recent',
    seeAll: 'See all files',
    unavailable: 'Can’t show these right now: the disk isn’t available.',
    empty: 'Your latest uploads and new items will appear here.',
    goToFiles: 'Go to Files',
    openFolder: 'Open folder',
    openNamed: 'Open “{name}”',
    downloadZip: 'Download as ZIP',
    download: 'Download',
  } satisfies Record<keyof typeof es, Message>,
};
