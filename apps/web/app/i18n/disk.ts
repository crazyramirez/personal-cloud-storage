import type { Message, MessageTable } from '~/utils/i18n';

const es = {
  dataDisk: 'Disco de datos',
  usbDisk: 'Disco USB',
  used: '{size} usados',
  free: '{size} libres',
} satisfies MessageTable;

export default {
  es,
  en: {
    dataDisk: 'Data disk',
    usbDisk: 'USB disk',
    used: '{size} used',
    free: '{size} free',
  } satisfies Record<keyof typeof es, Message>,
};
