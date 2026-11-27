import type { Translation } from '~/utils/i18n';
import type source from '../recent';

export default {
  title: '最近使用',
  seeAll: '查看所有文件',
  unavailable: '暂时无法显示：磁盘不可用。',
  empty: '你最近上传或创建的内容会显示在这里。',
  goToFiles: '前往“文件”',
  openFolder: '打开文件夹',
  openNamed: '在文件夹中显示（“{name}”）',
  downloadZip: '下载为 ZIP',
  download: '下载',
} satisfies Translation<typeof source>;
