import type { Translation } from '~/utils/i18n';
import type source from '../nav';

export default {
  mainNav: 'Hauptnavigation',
  version: 'Version {v}',
  tabNav: 'Navigation',
  remote: 'über Tailscale',
  local: 'lokales Netzwerk',
  dashboard: 'Übersicht',
  files: 'Dateien',
  trash: 'Papierkorb',
  activity: 'Aktivität',
  settings: 'Einstellungen',
  lightTheme: 'Zum hellen Design wechseln',
  darkTheme: 'Zum dunklen Design wechseln',
  signOut: 'Abmelden',
  tagline: 'Ihre Cloud auf Ihrer Festplatte',
} satisfies Translation<typeof source>;
