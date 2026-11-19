import type { Translation } from '~/utils/i18n';
import type source from '../setup';

export default {
  pageTitle: '初期設定 · Personal Cloud',
  title: '所有者アカウントの作成',
  lead: 'クラウドへのフルアクセス権を持つアカウントです。パスワードはメールで再設定できないため、安全な場所に保管してください。',
  code: 'セットアップコード',
  codeHelp: 'インストール時にサーバーが発行する 1 回限りのコードです（24 時間有効）。Raspberry Pi にアクセスできることの証明になります。',
  username: 'ユーザー名',
  usernameHelp: '英字、数字、ピリオド、ハイフン、アンダースコアが使用できます。',
  password: 'パスワード',
  passwordHelp: '{n} 文字以上。記号を含む単語より、覚えやすいフレーズのほうが安全です。',
  repeat: 'パスワードを再入力',
  mismatch: 'パスワードが一致しません。',
  creating: 'アカウントを作成中…',
  submit: 'アカウントを作成してサインイン',
  failed: 'アカウントを作成できませんでした',
} satisfies Translation<typeof source>;
