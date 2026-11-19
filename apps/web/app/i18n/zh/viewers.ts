import type { Translation } from '~/utils/i18n';
import type source from '../viewers';

export default {
  image: '查看图像',
  video: '播放视频',
  audio: '播放音频',
  pdf: '查看 PDF',
  text: '查看文本',
  office: '查看文稿',
  none: '查看详细信息',
} satisfies Translation<typeof source>;
