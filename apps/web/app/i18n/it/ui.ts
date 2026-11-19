import type { Translation } from '~/utils/i18n';
import type source from '../ui';

export default {
  actions: 'Azioni',
  couldNotComplete: 'Impossibile completare',
  forbiddenChars: 'Senza questi caratteri: \\ / : * ? " < > |',
  saving: 'Salvataggio…',
  dismissToast: 'Chiudi avviso',
  folderLoadFailed: 'Impossibile caricare la cartella',
  folderCreateFailed: 'Impossibile creare la cartella',
  currentFolder: 'Cartella attuale',
  noSubfolders: 'Nessuna sottocartella.',
  newFolderName: 'Nome della nuova cartella',
  create: 'Crea',
  forbiddenFolder: 'Non puoi scegliere questa cartella: è uno degli elementi o si trova al loro interno.',
  newFolder: 'Nuova cartella',
  preparingDownload: 'Preparazione di «{name}»…',
  downloadingPercent: 'Download di «{name}»… {pct}%',
  downloadingBytes: 'Download di «{name}»… {size}',
  downloadReady: '«{name}» è pronto',
  saveShare: 'Salva…',
  downloadFailed: 'Impossibile scaricare',
  downloadDefaultName: 'file',
} satisfies Translation<typeof source>;
