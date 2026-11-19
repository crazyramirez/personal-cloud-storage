import type { Translation } from '~/utils/i18n';
import type source from '../disk';

export default {
  dataDisk: 'Datenfestplatte',
  usbDisk: 'USB-Festplatte',
  used: '{size} belegt',
  free: '{size} frei',
} satisfies Translation<typeof source>;
