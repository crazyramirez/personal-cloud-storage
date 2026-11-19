import type { Translation } from '~/utils/i18n';
import type source from '../power';

export default {
  title: 'Neu starten oder ausschalten',
  intro: 'Das Gerät beendet die Dienste geordnet und hängt die Festplatten aus, bevor es neu startet oder sich ausschaltet: Es geht nichts verloren.',
  reboot: 'Neu starten',
  poweroff: 'Ausschalten',
  unavailable: 'Auf diesem Gerät nicht installiert: Wiederholen Sie die Installation (oder pcloud-install-power.sh --execute).',
  rebootTitle: 'Gerät neu starten?',
  rebootMessage: 'Die Cloud ist 1 bis 2 Minuten nicht verfügbar. Diese Seite lädt automatisch neu, sobald sie wieder da ist.',
  rebootConfirm: 'Neu starten',
  poweroffTitle: 'Gerät ausschalten?',
  poweroffMessage: 'Die Cloud funktioniert erst wieder, wenn Sie das Gerät einschalten. Der Raspberry Pi hat keinen Einschaltknopf: Zum Einschalten müssen Sie die Stromversorgung trennen und wieder anschließen – von unterwegs ist das also nicht möglich.',
  poweroffConfirm: 'Ausschalten',
  transfersWarning: 'Es laufen Übertragungen: Sie werden fortgesetzt, sobald das Gerät wieder da ist.',
  failed: 'Befehl konnte nicht gesendet werden',
  rebooting: 'Wird neu gestartet…',
  rebootingHint: 'Das dauert 1 bis 2 Minuten. Diese Seite lädt automatisch neu, sobald das Gerät wieder da ist.',
  rebootSlow: 'Es dauert länger als üblich. Wenn das Gerät nicht zurückkommt, prüfen Sie seine Stromversorgung.',
  back: 'Das Gerät läuft wieder',
  poweringOff: 'Gerät wird ausgeschaltet…',
  poweredOff: 'Gerät ausgeschaltet',
  poweredOffHint: 'Sobald die grüne LED des Raspberry Pi nicht mehr blinkt, können Sie ihn vom Strom trennen. Zum Einschalten schließen Sie die Stromversorgung wieder an.',
  close: 'Schließen',
} satisfies Translation<typeof source>;
