import type { Translation } from '~/utils/i18n';
import type source from '../search';

export default {
  placeholder: '„{name}“ durchsuchen',
  results: 'Suchergebnisse',
  searching: '„{name}“ und Unterordner werden durchsucht…',
  count: (p) => (Number(p.n) === 1 ? `1 Ergebnis in „${p.name}“ und Unterordnern` : `${p.n} Ergebnisse in „${p.name}“ und Unterordnern`),
  none: 'Nichts passt zu „{q}“ in „{name}“ oder seinen Unterordnern',
  noFavorites: 'Kein Favorit passt zur Suche',
  noneHint: 'Versuchen Sie ein anderes Wort oder einen Teil des Namens. Es wird nach allen Wörtern gesucht, ohne Groß-/Kleinschreibung und Akzente.',
  everywhere: 'In allen Dateien suchen',
  truncatedLimit: 'Es werden die ersten {n} Ergebnisse angezeigt: Geben Sie etwas Genaueres ein, um den Rest zu sehen.',
  truncatedTime: 'Es gibt sehr viele Dateien und die Suche wurde beendet, bevor alles durchsucht war: Es können Ergebnisse fehlen. Suchen Sie in einem genaueren Ordner.',
  inThisFolder: 'In diesem Ordner',
  location: 'In {path}',
  openLocation: 'Dateispeicherort öffnen',
  failed: 'Die Suche konnte nicht abgeschlossen werden.',
} satisfies Translation<typeof source>;
