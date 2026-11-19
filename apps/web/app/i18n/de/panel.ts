import type { Translation } from '~/utils/i18n';
import type source from '../panel';

export default {
  pageTitle: 'Übersicht · Personal Cloud',
  title: 'Übersicht',
  subtitle: 'Status Ihrer persönlichen Cloud',

  // Aviso de copia de seguridad
  backupAria: 'Hinweis: Sie haben noch kein Backup',
  backupTitle: 'Sie haben noch kein Backup',
  backupNoteAria: 'Backup-Hinweis',
  backupBody: 'Diese Festplatte ist der einzige Ort, an dem Ihre Dateien gespeichert sind: Wenn sie ausfällt oder verloren geht, gibt es keine weitere Kopie. Schließen Sie eine externe USB-Festplatte an und aktivieren Sie das Backup unter Einstellungen → Backup.',
  backupOkTitle: 'Backup ist aktuell',
  backupOkBody: 'Letztes Backup: {when}.',
  backupOldTitle: 'Backup ausstehend',
  backupOldBody: 'Das letzte Backup ist vom {when}. Schließen Sie die Backup-Festplatte an, um es zu aktualisieren.',
  backupNeverBody: 'Sie haben bereits eine Backup-Festplatte, aber es wurde noch kein Backup erstellt. Schließen Sie sie an, um das erste zu erstellen.',
  backupOpen: 'Backup öffnen',

  // Disco
  disk: 'Datenfestplatte',
  free: '{size} frei',
  usedOf: '{used} von {total} belegt',
  usedShort: 'belegt',
  checkingDisk: 'Festplatte wird geprüft…',
  format: 'Format',
  device: 'Gerät',
  reserve: 'Reserve',
  reserveHint: '{size}: darunter werden Uploads blockiert',
  checked: 'Geprüft',

  // Transferencias
  transfers: 'Uploads',
  activeCount: (p) => (Number(p.n) === 0 ? 'Keine laufenden Uploads' : Number(p.n) === 1 ? '1 läuft' : `${p.n} laufen`),
  finishedCount: (p) => (Number(p.n) === 1 ? '1 in dieser Sitzung abgeschlossen' : `${p.n} in dieser Sitzung abgeschlossen`),
  viewTransfers: 'Uploads anzeigen',

  // Acceso y seguridad
  access: 'Zugriff und Sicherheit',
  scope: 'Reichweite',
  scopeValue: 'Lokales Netzwerk und Ihre Tailscale-Geräte (privates VPN) · nie offen im Internet',
  viaTailscale: ' · Sie sind gerade über Tailscale verbunden',
  connection: 'Verbindung',
  encryptedTailscale: 'Verschlüsselt (HTTPS mit gültigem Tailscale-Zertifikat)',
  encryptedOwn: 'Verschlüsselt (HTTPS mit eigenem Zertifikat Ihres Servers)',
  unencrypted: 'Unverschlüsselt (HTTP): nur für Tests verwenden',
  trash: 'Papierkorb',
  viewTrash: 'Papierkorb anzeigen',
  trashEmpty: 'Leer',
  items: (p) => (Number(p.n) === 1 ? '1 Element' : `${p.n} Elemente`),
} satisfies Translation<typeof source>;
