import type { Translation } from '~/utils/i18n';
import type source from '../power';

export default {
  title: 'Redémarrer ou éteindre',
  intro: 'L’appareil arrête ses services dans l’ordre et démonte les disques avant de redémarrer ou de s’éteindre : rien n’est perdu.',
  reboot: 'Redémarrer',
  poweroff: 'Éteindre',
  unavailable: 'Non installé sur cet appareil : relancez l’installation (ou pcloud-install-power.sh --execute).',
  rebootTitle: 'Redémarrer l’appareil ?',
  rebootMessage: 'Le cloud sera indisponible pendant 1 ou 2 minutes. Cette page se rechargera d’elle-même à son retour.',
  rebootConfirm: 'Redémarrer',
  poweroffTitle: 'Éteindre l’appareil ?',
  poweroffMessage: 'Le cloud cessera de fonctionner jusqu’à ce que vous le rallumiez. Le Raspberry Pi n’a pas de bouton : pour l’allumer, il faut débrancher puis rebrancher l’alimentation, ce qui est impossible depuis l’extérieur de chez vous.',
  poweroffConfirm: 'Éteindre',
  transfersWarning: 'Des transferts sont en cours : ils reprendront au retour de l’appareil.',
  failed: 'Impossible d’envoyer la commande',
  rebooting: 'Redémarrage…',
  rebootingHint: 'Cela prend 1 ou 2 minutes. Cette page se rechargera d’elle-même au retour de l’appareil.',
  rebootSlow: 'Cela prend plus de temps que d’habitude. S’il ne revient pas, vérifiez l’alimentation de l’appareil.',
  back: 'L’appareil est de nouveau en marche',
  poweringOff: 'Arrêt de l’appareil…',
  poweredOff: 'Appareil éteint',
  poweredOffHint: 'Quand le voyant vert du Raspberry Pi cesse de clignoter, vous pouvez le débrancher. Pour l’allumer, rebranchez l’alimentation.',
  close: 'Fermer',
} satisfies Translation<typeof source>;
