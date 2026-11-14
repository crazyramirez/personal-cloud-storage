import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  mainNav: 'Navegación principal',
  tabNav: 'Navegación',
  remote: 'vía Tailscale',
  local: 'red local',
  dashboard: 'Panel',
  files: 'Archivos',
  trash: 'Papelera',
  activity: 'Actividad',
  settings: 'Ajustes',
  lightTheme: 'Cambiar a tema claro',
  darkTheme: 'Cambiar a tema oscuro',
  signOut: 'Salir',
  tagline: 'Tu nube en tu disco',
} satisfies MessageTable;

export default {
  es,
  en: {
    mainNav: 'Main navigation',
    tabNav: 'Navigation',
    remote: 'via Tailscale',
    local: 'local network',
    dashboard: 'Dashboard',
    files: 'Files',
    trash: 'Trash',
    activity: 'Activity',
    settings: 'Settings',
    lightTheme: 'Switch to light theme',
    darkTheme: 'Switch to dark theme',
    signOut: 'Sign out',
    tagline: 'Your cloud on your own disk',
  } satisfies Record<keyof typeof es, Message>,
};
