import type { Translation } from '~/utils/i18n';
import type source from '../recent';

export default {
  title: 'Zuletzt verwendet',
  seeAll: 'Alle Dateien anzeigen',
  unavailable: 'Derzeit nicht verfügbar: Die Festplatte ist nicht erreichbar.',
  empty: 'Hier erscheint, was Sie zuletzt hochladen oder erstellen.',
  goToFiles: 'Zu Dateien',
  openFolder: 'Ordner öffnen',
  openNamed: 'Im Ordner anzeigen („{name}“)',
  downloadZip: 'Als ZIP herunterladen',
  download: 'Herunterladen',
} satisfies Translation<typeof source>;
