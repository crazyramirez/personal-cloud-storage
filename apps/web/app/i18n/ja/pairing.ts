import type { Translation } from '~/utils/i18n';
import type source from '../pairing';

export default {
  title: 'コンピュータのバックアップ',
  intro: 'DEV Backup Studio を使うと、コンピュータのバックアップをクラウドに保存できます。パスワードは入力せず、コードで接続します。',
  connect: 'コンピュータを接続',
  newCode: '別のコード',
  cancel: '取り消す',
  codeLabel: '接続コード',
  step1: 'コンピュータで DEV Backup Studio を開きます。',
  step2: '「マイクラウドに接続」をクリックします。',
  step3: 'このコードを入力します。',
  expires: ({ min }) => `${min} 分後に期限切れになります。使用できるのは 1 回だけです。`,
  expired: 'コードの有効期限が切れました。',
  where: ({ host, share }) => `バックアップはクラウドの「${share}」フォルダ（\\\\${host}\\${share}）に保存されます。`,
  unavailable: 'このデバイスにはネットワークフォルダがインストールされていません。有効にするには、サーバーで次を実行してください: sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: 'コードを作成できませんでした',
  copied: 'コードをコピーしました',
  copy: 'コードをコピー',
} satisfies Translation<typeof source>;
