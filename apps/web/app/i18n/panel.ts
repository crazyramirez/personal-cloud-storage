import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  pageTitle: 'Panel · Personal Cloud',
  title: 'Panel',
  subtitle: 'Estado de tu nube personal',

  // Aviso de copia de seguridad
  backupAria: 'Aviso: todavía no tienes copia de seguridad',
  backupTitle: 'Todavía no tienes copia de seguridad',
  backupNoteAria: 'Aviso de copia de seguridad',
  backupBody: 'Este disco es el único lugar donde se guardan tus archivos: si se avería o se pierde, no hay otra copia. Conecta un disco USB externo y actívala en Ajustes → Copia de seguridad.',
  backupOkTitle: 'Copia de seguridad al día',
  backupOkBody: 'Última copia: {when}.',
  backupOldTitle: 'Copia de seguridad pendiente',
  backupOldBody: 'La última copia es de {when}. Conecta el disco de copia para ponerla al día.',
  backupNeverBody: 'Ya tienes disco de copia, pero aún no se ha hecho ninguna. Conéctalo para hacer la primera.',
  backupOpen: 'Abrir copia de seguridad',

  // Disco
  disk: 'Disco de datos',
  free: '{size} libres',
  usedOf: '{used} usados de {total}',
  usedShort: 'en uso',
  checkingDisk: 'Comprobando el disco…',
  format: 'Formato',
  device: 'Dispositivo',
  reserve: 'Reserva',
  reserveHint: '{size}: por debajo se bloquean las subidas',
  checked: 'Comprobado',

  // Transferencias
  transfers: 'Subidas',
  activeCount: (p) => (Number(p.n) === 0 ? 'Sin subidas en curso' : Number(p.n) === 1 ? '1 en curso' : `${p.n} en curso`),
  finishedCount: (p) => (Number(p.n) === 1 ? '1 completada en esta sesión' : `${p.n} completadas en esta sesión`),
  viewTransfers: 'Ver subidas',

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
    backupBody: 'This disk is the only place your files are stored: if it fails or gets lost, there’s no other copy. Connect an external USB disk and turn it on in Settings → Backup.',
    backupOkTitle: 'Backup up to date',
    backupOkBody: 'Last backup: {when}.',
    backupOldTitle: 'Backup pending',
    backupOldBody: 'The last backup is from {when}. Connect the backup disk to bring it up to date.',
    backupNeverBody: 'You have a backup disk, but no backup has been made yet. Connect it to make the first one.',
    backupOpen: 'Open backup',

    disk: 'Data disk',
    free: '{size} free',
    usedOf: '{used} used of {total}',
    usedShort: 'in use',
    checkingDisk: 'Checking the disk…',
    format: 'Format',
    device: 'Device',
    reserve: 'Reserve',
    reserveHint: '{size}: uploads are blocked below this',
    checked: 'Checked',

    transfers: 'Uploads',
    activeCount: (p) => (Number(p.n) === 0 ? 'No uploads in progress' : Number(p.n) === 1 ? '1 in progress' : `${p.n} in progress`),
    finishedCount: (p) => (Number(p.n) === 1 ? '1 completed this session' : `${p.n} completed this session`),
    viewTransfers: 'View uploads',

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
