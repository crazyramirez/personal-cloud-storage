import type { Translation } from '~/utils/i18n';
import type source from '../search';

export default {
  placeholder: '在“{name}”中搜索',
  results: '搜索结果',
  searching: '正在搜索“{name}”及其子文件夹…',
  count: (p) => `在“${p.name}”及其子文件夹中找到 ${p.n} 个结果`,
  none: '在“{name}”及其子文件夹中没有与“{q}”匹配的内容',
  noFavorites: '没有与搜索匹配的收藏',
  noneHint: '试试其他词或名称的一部分。会搜索所有词，不区分大小写和重音。',
  everywhere: '在所有文件中搜索',
  truncatedLimit: '仅显示前 {n} 个结果：输入更具体的内容以查看其余结果。',
  truncatedTime: '文件非常多，搜索在检查完所有内容之前就停止了：可能缺少一些结果。请从更具体的文件夹开始搜索。',
  inThisFolder: '在此文件夹中',
  location: '位于 {path}',
  openLocation: '在文件夹中显示（“{name}”）',
  failed: '无法完成搜索。',
  indexBuilding: '正在准备搜索索引（首次需要几分钟）：在此期间直接在磁盘上搜索，可能缺少部分结果。',
  indexAge: '索引更新于{when}',
} satisfies Translation<typeof source>;
