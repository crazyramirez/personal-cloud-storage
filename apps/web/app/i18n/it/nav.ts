import type { Translation } from '~/utils/i18n';
import type source from '../nav';

export default {
  mainNav: 'Navigazione principale',
  version: 'Versione {v}',
  tabNav: 'Navigazione',
  remote: 'tramite Tailscale',
  local: 'rete locale',
  dashboard: 'Pannello',
  files: 'File',
  trash: 'Cestino',
  activity: 'Attività',
  settings: 'Impostazioni',
  lightTheme: 'Passa al tema chiaro',
  darkTheme: 'Passa al tema scuro',
  signOut: 'Esci',
  tagline: 'Il tuo cloud sul tuo disco',
} satisfies Translation<typeof source>;
