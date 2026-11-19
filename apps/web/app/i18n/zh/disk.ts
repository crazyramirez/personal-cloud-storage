import type { Translation } from '~/utils/i18n';
import type source from '../disk';

export default {
  dataDisk: '数据磁盘',
  usbDisk: 'USB 磁盘',
  used: '已用 {size}',
  free: '可用 {size}',
} satisfies Translation<typeof source>;
