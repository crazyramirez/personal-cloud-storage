import type { Translation } from '~/utils/i18n';
import type source from '../pairing';

export default {
  title: 'Sauvegardes de vos ordinateurs',
  intro: 'Vos ordinateurs peuvent enregistrer leur sauvegarde dans le cloud avec DEV Backup Studio. Ils se connectent avec un code, sans saisir de mot de passe.',
  connect: 'Connecter un ordinateur',
  newCode: 'Nouveau code',
  cancel: 'Annuler',
  codeLabel: 'Code de connexion',
  step1: 'Sur l’ordinateur, ouvrez DEV Backup Studio.',
  step2: 'Cliquez sur « Se connecter à mon cloud ».',
  step3: 'Saisissez ce code.',
  expires: ({ min }) => `Expire dans ${min} min et ne peut servir qu’une seule fois.`,
  expired: 'Le code a expiré.',
  where: ({ host, share }) => `Les sauvegardes sont enregistrées dans le dossier « ${share} » du cloud (\\\\${host}\\${share}).`,
  unavailable: 'Le dossier réseau n’est pas installé sur cet appareil. Pour l’activer, exécutez sur le serveur : sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: 'Impossible de créer le code',
  copied: 'Code copié',
  copy: 'Copier le code',
} satisfies Translation<typeof source>;
