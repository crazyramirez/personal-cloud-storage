import type { Translation } from '~/utils/i18n';
import type source from '../panel';

export default {
  pageTitle: 'Tableau de bord · Personal Cloud',
  title: 'Tableau de bord',
  subtitle: 'État de votre cloud personnel',

  // Avis de sauvegarde
  backupAria: 'Avertissement : vous n’avez pas encore de sauvegarde',
  backupTitle: 'Vous n’avez pas encore de sauvegarde',
  backupNoteAria: 'Avis de sauvegarde',
  backupBody: 'Ce disque est le seul endroit où vos fichiers sont stockés : s’il tombe en panne ou se perd, il n’existe aucune autre copie. Branchez un disque USB externe et activez la sauvegarde dans Réglages → Sauvegarde.',
  backupOkTitle: 'Sauvegarde à jour',
  backupOkBody: 'Dernière sauvegarde : {when}.',
  backupOldTitle: 'Sauvegarde en attente',
  backupOldBody: 'La dernière sauvegarde date de {when}. Branchez le disque de sauvegarde pour la mettre à jour.',
  backupNeverBody: 'Vous avez un disque de sauvegarde, mais aucune sauvegarde n’a encore été effectuée. Branchez-le pour faire la première.',
  backupOpen: 'Ouvrir la sauvegarde',

  // Disque
  disk: 'Disque de données',
  free: '{size} libres',
  usedOf: '{used} utilisés sur {total}',
  usedShort: 'utilisé',
  checkingDisk: 'Vérification du disque…',
  format: 'Format',
  device: 'Périphérique',
  reserve: 'Réserve',
  reserveHint: '{size} : en dessous, les importations sont bloquées',
  checked: 'Vérifié',

  // Transferts
  transfers: 'Importations',
  activeCount: (p) => (Number(p.n) === 0 ? 'Aucune importation en cours' : `${p.n} en cours`),
  finishedCount: (p) => (Number(p.n) <= 1 ? `${p.n} terminée pendant cette session` : `${p.n} terminées pendant cette session`),
  viewTransfers: 'Voir les importations',

  // Accès et sécurité
  access: 'Accès et sécurité',
  scope: 'Portée',
  scopeValue: 'Réseau local et vos appareils Tailscale (VPN privé) · jamais ouvert sur Internet',
  viaTailscale: ' · vous êtes connecté via Tailscale',
  connection: 'Connexion',
  encryptedTailscale: 'Chiffrée (HTTPS avec un certificat Tailscale valide)',
  encryptedOwn: 'Chiffrée (HTTPS avec le certificat propre à votre serveur)',
  unencrypted: 'Non chiffrée (HTTP) : à utiliser uniquement pour des tests',
  trash: 'Corbeille',
  viewTrash: 'Voir la corbeille',
  trashEmpty: 'Vide',
  items: (p) => (Number(p.n) <= 1 ? `${p.n} élément` : `${p.n} éléments`),
} satisfies Translation<typeof source>;
