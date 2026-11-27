import type { Translation } from '~/utils/i18n';
import type source from '../recent';

export default {
  title: '最近の項目',
  seeAll: 'すべてのファイルを表示',
  unavailable: 'ディスクを使用できないため、現在表示できません。',
  empty: '最近アップロードまたは作成したものがここに表示されます。',
  goToFiles: 'ファイルへ移動',
  openFolder: 'フォルダを開く',
  openNamed: 'フォルダーで表示（「{name}」）',
  downloadZip: 'ZIP でダウンロード',
  download: 'ダウンロード',
} satisfies Translation<typeof source>;
