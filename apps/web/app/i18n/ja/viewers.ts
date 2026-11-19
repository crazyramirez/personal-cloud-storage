import type { Translation } from '~/utils/i18n';
import type source from '../viewers';

export default {
  image: '画像を表示',
  video: 'ビデオを再生',
  audio: 'オーディオを再生',
  pdf: 'PDF を表示',
  text: 'テキストを表示',
  office: '書類を表示',
  none: '詳細を表示',
} satisfies Translation<typeof source>;
