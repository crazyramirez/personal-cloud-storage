import type { Translation } from '~/utils/i18n';
import type source from '../auth';

export default {
  pageTitle: 'サインイン · Personal Cloud',
  title: 'サインイン',
  subtitle: 'あなたのパーソナルクラウドにアクセスします。',
  withPasskey: 'パスキーでサインイン',
  passkeyHint: 'Face ID、Touch ID、Windows Hello、またはスマートフォンの指紋認証。',
  orPassword: 'またはパスワードを使用',
  username: 'ユーザー名',
  password: 'パスワード',
  checking: '確認中…',
  submit: 'サインイン',
  passkeyUnsupportedBefore: 'Face ID や Windows Hello でサインインするには、証明書をインストールした状態で ',
  passkeyUnsupportedAfter: ' を開いてください（IP アドレスではありません）。',
  loginFailed: 'サインインできませんでした',
  thisDevice: 'このデバイス',
  cancelled: '操作がキャンセルされました',
  passkeyTimeout: 'キャンセルされたか、タイムアウトしました。もう一度お試しください。',
  passkeyExists: 'このデバイスには、すでにあなたのアカウントのパスキーが登録されています。',
  passkeyInsecure: 'このブラウザでは、ここでパスキーを使用できません。証明書をインストールし、HTTPS で .local 名を使ってアプリを開いてください。',
  passkeyFailed: '完了できませんでした',
} satisfies Translation<typeof source>;
