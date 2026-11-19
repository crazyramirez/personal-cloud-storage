import type { Translation } from '~/utils/i18n';
import type source from '../disk';

export default {
  dataDisk: 'データディスク',
  usbDisk: 'USB ディスク',
  used: '{size} 使用済み',
  free: '{size} 空き',
} satisfies Translation<typeof source>;
