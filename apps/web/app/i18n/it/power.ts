import type { Translation } from '~/utils/i18n';
import type source from '../power';

export default {
  title: 'Riavvia o spegni',
  intro: 'Il dispositivo arresta i servizi in modo ordinato e smonta i dischi prima di riavviarsi o spegnersi: non si perde nulla.',
  reboot: 'Riavvia',
  poweroff: 'Spegni',
  unavailable: 'Non è installato su questo dispositivo: ripeti l’installazione (o pcloud-install-power.sh --execute).',
  rebootTitle: 'Riavviare il dispositivo?',
  rebootMessage: 'Il cloud non sarà disponibile per 1 o 2 minuti. Questa pagina si ricaricherà da sola quando tornerà attivo.',
  rebootConfirm: 'Riavvia',
  poweroffTitle: 'Spegnere il dispositivo?',
  poweroffMessage: 'Il cloud smetterà di funzionare finché non lo riaccendi. Il Raspberry Pi non ha un pulsante: per accenderlo bisogna scollegare l’alimentazione e ricollegarla, quindi da fuori casa non potrai farlo.',
  poweroffConfirm: 'Spegni',
  transfersWarning: 'Ci sono trasferimenti in corso: riprenderanno quando il dispositivo tornerà attivo.',
  failed: 'Impossibile inviare il comando',
  rebooting: 'Riavvio in corso…',
  rebootingHint: 'Richiede 1 o 2 minuti. Questa pagina si ricaricherà da sola quando il dispositivo tornerà attivo.',
  rebootSlow: 'Sta impiegando più del solito. Se non torna attivo, controlla l’alimentazione del dispositivo.',
  back: 'Il dispositivo è di nuovo attivo',
  poweringOff: 'Spegnimento del dispositivo…',
  poweredOff: 'Dispositivo spento',
  poweredOffHint: 'Quando la luce verde del Raspberry Pi smette di lampeggiare, puoi scollegarlo. Per accenderlo, ricollega l’alimentazione.',
  close: 'Chiudi',
} satisfies Translation<typeof source>;
