import type { Translation } from '~/utils/i18n';
import type source from '../panel';

export default {
  pageTitle: 'Pannello · Personal Cloud',
  title: 'Pannello',
  subtitle: 'Stato del tuo cloud personale',

  // Aviso de copia de seguridad
  backupAria: 'Avviso: non hai ancora un backup',
  backupTitle: 'Non hai ancora un backup',
  backupNoteAria: 'Avviso sul backup',
  backupBody: 'Questo disco è l’unico posto in cui sono salvati i tuoi file: se si guasta o va perso, non esiste un’altra copia. Collega un disco USB esterno e attiva il backup in Impostazioni → Backup.',
  backupOkTitle: 'Backup aggiornato',
  backupOkBody: 'Ultimo backup: {when}.',
  backupOldTitle: 'Backup da aggiornare',
  backupOldBody: 'L’ultimo backup risale a {when}. Collega il disco di backup per aggiornarlo.',
  backupNeverBody: 'Hai già un disco di backup, ma non è stato ancora fatto alcun backup. Collegalo per fare il primo.',
  backupOpen: 'Apri backup',

  // Disco
  disk: 'Disco dati',
  free: '{size} liberi',
  usedOf: '{used} usati su {total}',
  usedShort: 'in uso',
  checkingDisk: 'Controllo del disco…',
  format: 'Formato',
  device: 'Dispositivo',
  reserve: 'Riserva',
  reserveHint: '{size}: al di sotto i caricamenti vengono bloccati',
  checked: 'Controllato',

  // Transferencias
  transfers: 'Caricamenti',
  activeCount: (p) => (Number(p.n) === 0 ? 'Nessun caricamento in corso' : Number(p.n) === 1 ? '1 in corso' : `${p.n} in corso`),
  finishedCount: (p) => (Number(p.n) === 1 ? '1 completato in questa sessione' : `${p.n} completati in questa sessione`),
  viewTransfers: 'Mostra caricamenti',

  // Acceso y seguridad
  access: 'Accesso e sicurezza',
  scope: 'Ambito',
  scopeValue: 'Rete locale e i tuoi dispositivi Tailscale (VPN privata) · mai aperto a Internet',
  viaTailscale: ' · ora accedi tramite Tailscale',
  connection: 'Connessione',
  encryptedTailscale: 'Crittografata (HTTPS con certificato valido di Tailscale)',
  encryptedOwn: 'Crittografata (HTTPS con certificato proprio del tuo server)',
  unencrypted: 'Non crittografata (HTTP): usala solo per prove',
  trash: 'Cestino',
  viewTrash: 'Mostra cestino',
  trashEmpty: 'Vuoto',
  items: (p) => (Number(p.n) === 1 ? '1 elemento' : `${p.n} elementi`),
} satisfies Translation<typeof source>;
