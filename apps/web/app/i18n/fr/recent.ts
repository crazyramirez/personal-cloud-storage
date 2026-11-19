import type { Translation } from '~/utils/i18n';
import type source from '../recent';

export default {
  title: 'Récents',
  seeAll: 'Voir tous les fichiers',
  unavailable: 'Impossible de les afficher pour le moment : le disque n’est pas disponible.',
  empty: 'Vos derniers fichiers importés ou créés apparaîtront ici.',
  goToFiles: 'Aller aux fichiers',
  openFolder: 'Ouvrir le dossier',
  openNamed: 'Ouvrir « {name} »',
  downloadZip: 'Télécharger en ZIP',
  download: 'Télécharger',
} satisfies Translation<typeof source>;
