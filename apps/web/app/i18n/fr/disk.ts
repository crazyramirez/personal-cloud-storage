import type { Translation } from '~/utils/i18n';
import type source from '../disk';

export default {
  dataDisk: 'Disque de données',
  usbDisk: 'Disque USB',
  used: '{size} utilisés',
  free: '{size} libres',
} satisfies Translation<typeof source>;
