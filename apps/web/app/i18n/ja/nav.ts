import type { Translation } from '~/utils/i18n';
import type source from '../nav';

export default {
  mainNav: 'メインナビゲーション',
  version: 'バージョン {v}',
  tabNav: 'ナビゲーション',
  remote: 'Tailscale 経由',
  local: 'ローカルネットワーク',
  dashboard: 'ダッシュボード',
  files: 'ファイル',
  trash: 'ゴミ箱',
  activity: 'アクティビティ',
  settings: '設定',
  lightTheme: 'ライトテーマに切り替え',
  darkTheme: 'ダークテーマに切り替え',
  signOut: 'サインアウト',
  tagline: 'あなたのディスクに、あなたのクラウドを',
} satisfies Translation<typeof source>;
