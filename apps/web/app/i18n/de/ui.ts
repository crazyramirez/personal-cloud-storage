import type { Translation } from '~/utils/i18n';
import type source from '../ui';

export default {
  actions: 'Aktionen',
  couldNotComplete: 'Vorgang konnte nicht abgeschlossen werden',
  forbiddenChars: 'Ohne diese Zeichen: \\ / : * ? " < > |',
  saving: 'Wird gespeichert…',
  dismissToast: 'Hinweis schließen',
  folderLoadFailed: 'Ordner konnte nicht geladen werden',
  folderCreateFailed: 'Ordner konnte nicht erstellt werden',
  currentFolder: 'Aktueller Ordner',
  noSubfolders: 'Keine Unterordner.',
  newFolderName: 'Name des neuen Ordners',
  create: 'Erstellen',
  forbiddenFolder: 'Dieser Ordner kann nicht gewählt werden: Er ist eines der Elemente oder befindet sich darin.',
  newFolder: 'Neuer Ordner',
  preparingDownload: '„{name}“ wird vorbereitet…',
  downloadingPercent: '„{name}“ wird heruntergeladen… {pct} %',
  downloadingBytes: '„{name}“ wird heruntergeladen… {size}',
  downloadReady: '„{name}“ ist bereit',
  saveShare: 'Speichern…',
  downloadFailed: 'Download fehlgeschlagen',
  downloadDefaultName: 'datei',
} satisfies Translation<typeof source>;
