import type { Translation } from '~/utils/i18n';
import type source from '../search';

export default {
  placeholder: '「{name}」を検索',
  results: '検索結果',
  searching: '「{name}」とサブフォルダーを検索しています…',
  count: (p) => `「${p.name}」とサブフォルダーで ${p.n} 件見つかりました`,
  none: '「{name}」とサブフォルダーに「{q}」に一致するものはありません',
  noFavorites: '検索に一致するお気に入りはありません',
  noneHint: '別の単語や名前の一部で試してください。すべての単語を、大文字小文字やアクセントを区別せずに検索します。',
  everywhere: 'すべてのファイルを検索',
  truncatedLimit: '最初の {n} 件を表示しています。残りを見るには、より具体的に入力してください。',
  truncatedTime: 'ファイルが非常に多いため、すべてを確認する前に検索を停止しました。結果が不足している可能性があります。より具体的なフォルダーから検索してください。',
  inThisFolder: 'このフォルダー内',
  location: '場所: {path}',
  openLocation: 'ファイルの場所を開く',
  failed: '検索を完了できませんでした。',
  indexBuilding: '検索インデックスを準備しています（初回は数分かかります）。それまではディスクを直接検索するため、結果が不足することがあります。',
  indexAge: 'インデックス: {when}',
} satisfies Translation<typeof source>;
