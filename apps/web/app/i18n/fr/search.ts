import type { Translation } from '~/utils/i18n';
import type source from '../search';

export default {
  placeholder: 'Rechercher dans « {name} »',
  results: 'Résultats de la recherche',
  searching: 'Recherche dans « {name} » et ses sous-dossiers…',
  count: (p) => (Number(p.n) === 1 ? `1 résultat dans « ${p.name} » et ses sous-dossiers` : `${p.n} résultats dans « ${p.name} » et ses sous-dossiers`),
  none: 'Rien ne correspond à « {q} » dans « {name} » ni dans ses sous-dossiers',
  noFavorites: 'Aucun favori ne correspond à la recherche',
  noneHint: 'Essayez un autre mot ou une partie du nom. Tous les mots sont recherchés, sans tenir compte des majuscules ni des accents.',
  everywhere: 'Rechercher dans tous les fichiers',
  truncatedLimit: 'Seuls les {n} premiers résultats sont affichés : précisez la recherche pour voir la suite.',
  truncatedTime: 'Il y a énormément de fichiers et la recherche s’est arrêtée avant de tout parcourir : des résultats peuvent manquer. Lancez-la depuis un dossier plus précis.',
  inThisFolder: 'Dans ce dossier',
  location: 'Dans {path}',
  openLocation: 'Ouvrir l’emplacement',
  failed: 'La recherche n’a pas pu aboutir.',
} satisfies Translation<typeof source>;
