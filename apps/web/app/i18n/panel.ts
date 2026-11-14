import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  pageTitle: 'Panel · Personal Cloud',
  title: 'Panel',
  subtitle: 'Estado de tu nube personal',

  // Aviso de copia de seguridad
  backupAria: 'Aviso: todavía no tienes copia de seguridad',
  backupTitle: 'Todavía no tienes copia de seguridad',
  backupNoteAria: 'Aviso de copia de seguridad',
  backupBody: 'Este disco es el único lugar donde se guardan tus archivos: si se avería o se pierde, no hay otra copia. Guarda una copia de lo importante en otro disco.',

  // Disco
  disk: 'Disco de datos',
  free: '{size} libres',
  usedOf: '{used} usados de {total}',
  checkingDisk: 'Comprobando el disco…',
  format: 'Formato',
  device: 'Dispositivo',
  reserve: 'Reserva',
  reserveHint: '{size}: por debajo se bloquean las subidas',
  checked: 'Comprobado',

  // Transferencias
  transfers: 'Transferencias',
  activeCount: (p) => (Number(p.n) === 0 ? 'Sin subidas en curso' : Number(p.n) === 1 ? '1 en curso' : `${p.n} en curso`),
  finishedCount: (p) => (Number(p.n) === 1 ? '1 completada en esta sesión' : `${p.n} completadas en esta sesión`),
  viewTransfers: 'Ver transferencias',

  // Acceso y seguridad
  access: 'Acceso y seguridad',
  scope: 'Alcance',
  scopeValue: 'Red local y tus dispositivos de Tailscale (VPN privada) · nunca abierto a Internet',
  viaTailscale: ' · ahora entras por Tailscale',
  connection: 'Conexión',
  encryptedTailscale: 'Cifrada (HTTPS con certificado válido de Tailscale)',
  encryptedOwn: 'Cifrada (HTTPS con certificado propio de tu servidor)',
  unencrypted: 'Sin cifrar (HTTP): úsala solo para pruebas',
  trash: 'Papelera',
  viewTrash: 'Ver papelera',
  trashEmpty: 'Vacía',
  items: (p) => (Number(p.n) === 1 ? '1 elemento' : `${p.n} elementos`),
} satisfies MessageTable;

export default {
  es,
  en: {
    pageTitle: 'Dashboard · Personal Cloud',
    title: 'Dashboard',
    subtitle: 'Your personal cloud at a glance',

    backupAria: 'Warning: you don’t have a backup yet',
    backupTitle: 'You don’t have a backup yet',
    backupNoteAria: 'Backup warning',
    backupBody: 'This disk is the only place your files are stored: if it fails or gets lost, there’s no other copy. Keep a copy of anything important on another disk.',

    disk: 'Data disk',
    free: '{size} free',
    usedOf: '{used} used of {total}',
    checkingDisk: 'Checking the disk…',
    format: 'Format',
    device: 'Device',
    reserve: 'Reserve',
    reserveHint: '{size}: uploads are blocked below this',
    checked: 'Checked',

    transfers: 'Transfers',
    activeCount: (p) => (Number(p.n) === 0 ? 'No uploads in progress' : Number(p.n) === 1 ? '1 in progress' : `${p.n} in progress`),
    finishedCount: (p) => (Number(p.n) === 1 ? '1 completed this session' : `${p.n} completed this session`),
    viewTransfers: 'View transfers',

    access: 'Access and security',
    scope: 'Access',
    scopeValue: 'Local network and your Tailscale devices (private VPN) · never exposed to the Internet',
    viaTailscale: ' · you’re connected via Tailscale now',
    connection: 'Connection',
    encryptedTailscale: 'Encrypted (HTTPS with a valid Tailscale certificate)',
    encryptedOwn: 'Encrypted (HTTPS with your server’s own certificate)',
    unencrypted: 'Not encrypted (HTTP): use it for testing only',
    trash: 'Trash',
    viewTrash: 'View Trash',
    trashEmpty: 'Nothing in Trash',
    items: (p) => (Number(p.n) === 1 ? '1 item' : `${p.n} items`),
  } satisfies Record<keyof typeof es, Message>,
};
