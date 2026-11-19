import type { Translation } from '~/utils/i18n';
import type source from '../nav';

export default {
  mainNav: 'Navigation principale',
  version: 'Version {v}',
  tabNav: 'Navigation',
  remote: 'via Tailscale',
  local: 'réseau local',
  dashboard: 'Tableau de bord',
  files: 'Fichiers',
  trash: 'Corbeille',
  activity: 'Activité',
  settings: 'Réglages',
  lightTheme: 'Passer au thème clair',
  darkTheme: 'Passer au thème sombre',
  signOut: 'Se déconnecter',
  tagline: 'Votre cloud sur votre propre disque',
} satisfies Translation<typeof source>;
