import type { Translation } from '~/utils/i18n';
import type source from '../pairing';

export default {
  title: 'Backups Ihrer Computer',
  intro: 'Ihre Computer können ihr Backup mit DEV Backup Studio in der Cloud speichern. Sie verbinden sich mit einem Code, ohne Passworteingabe.',
  connect: 'Computer verbinden',
  newCode: 'Neuer Code',
  cancel: 'Widerrufen',
  codeLabel: 'Verbindungscode',
  step1: 'Öffnen Sie DEV Backup Studio auf dem Computer.',
  step2: 'Klicken Sie auf „Mit meiner Cloud verbinden“.',
  step3: 'Geben Sie diesen Code ein.',
  expires: ({ min }) => `Läuft in ${min} min ab und gilt nur einmal.`,
  expired: 'Der Code ist abgelaufen.',
  where: ({ host, share }) => `Die Backups werden im Cloud-Ordner „${share}“ gespeichert (\\\\${host}\\${share}).`,
  unavailable: 'Der Netzwerkordner ist auf diesem Gerät nicht installiert. Führen Sie zum Aktivieren auf dem Server aus: sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: 'Code konnte nicht erstellt werden',
  copied: 'Code kopiert',
  copy: 'Code kopieren',
} satisfies Translation<typeof source>;
