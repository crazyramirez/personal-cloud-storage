import type { Translation } from '~/utils/i18n';
import type source from '../disk';

export default {
  dataDisk: 'Disco dati',
  usbDisk: 'Disco USB',
  used: '{size} usati',
  free: '{size} liberi',
} satisfies Translation<typeof source>;
