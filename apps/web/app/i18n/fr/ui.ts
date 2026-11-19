import type { Translation } from '~/utils/i18n';
import type source from '../ui';

export default {
  actions: 'Actions',
  couldNotComplete: 'Impossible de terminer l’opération',
  forbiddenChars: 'Sans ces caractères : \\ / : * ? " < > |',
  saving: 'Enregistrement…',
  dismissToast: 'Fermer la notification',
  folderLoadFailed: 'Impossible de charger le dossier',
  folderCreateFailed: 'Impossible de créer le dossier',
  currentFolder: 'Dossier actuel',
  noSubfolders: 'Aucun sous-dossier.',
  newFolderName: 'Nom du nouveau dossier',
  create: 'Créer',
  forbiddenFolder: 'Impossible de choisir ce dossier : il fait partie des éléments ou se trouve à l’intérieur de l’un d’eux.',
  newFolder: 'Nouveau dossier',
  preparingDownload: 'Préparation de « {name} »…',
  downloadingPercent: 'Téléchargement de « {name} »… {pct} %',
  downloadingBytes: 'Téléchargement de « {name} »… {size}',
  downloadReady: '« {name} » est prêt',
  saveShare: 'Enregistrer…',
  downloadFailed: 'Impossible de télécharger',
  downloadDefaultName: 'fichier',
} satisfies Translation<typeof source>;
