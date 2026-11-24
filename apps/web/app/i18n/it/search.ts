import type { Translation } from '~/utils/i18n';
import type source from '../search';

export default {
  placeholder: 'Cerca in «{name}»',
  results: 'Risultati della ricerca',
  searching: 'Ricerca in «{name}» e nelle sottocartelle…',
  count: (p) => (Number(p.n) === 1 ? `1 risultato in «${p.name}» e nelle sottocartelle` : `${p.n} risultati in «${p.name}» e nelle sottocartelle`),
  none: 'Niente corrisponde a «{q}» in «{name}» o nelle sue sottocartelle',
  noFavorites: 'Nessun preferito corrisponde alla ricerca',
  noneHint: 'Prova con un’altra parola o con parte del nome. Si cercano tutte le parole, senza distinguere maiuscole e accenti.',
  everywhere: 'Cerca in tutti i file',
  truncatedLimit: 'Sono mostrati i primi {n} risultati: scrivi qualcosa di più preciso per vedere gli altri.',
  truncatedTime: 'Ci sono moltissimi file e la ricerca si è fermata prima di controllare tutto: potrebbero mancare risultati. Cerca da una cartella più precisa.',
  inThisFolder: 'In questa cartella',
  location: 'In {path}',
  openLocation: 'Apri percorso',
  failed: 'Impossibile completare la ricerca.',
  indexBuilding: 'Preparazione dell’indice di ricerca (la prima volta richiede qualche minuto): nel frattempo si cerca direttamente sul disco e potrebbero mancare risultati.',
  indexAge: 'indice {when}',
} satisfies Translation<typeof source>;
