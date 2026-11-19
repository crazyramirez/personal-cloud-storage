import type { Translation } from '~/utils/i18n';
import type source from '../power';

export default {
  title: '再起動またはシャットダウン',
  intro: '再起動やシャットダウンの前に、サービスを順番に停止し、ディスクをアンマウントします。データが失われることはありません。',
  reboot: '再起動',
  poweroff: 'シャットダウン',
  unavailable: 'このデバイスにはインストールされていません。インストールをやり直してください（または pcloud-install-power.sh --execute）。',
  rebootTitle: 'デバイスを再起動しますか？',
  rebootMessage: '1〜2 分間クラウドを使用できなくなります。復帰すると、このページは自動で再読み込みされます。',
  rebootConfirm: '再起動',
  poweroffTitle: 'デバイスをシャットダウンしますか？',
  poweroffMessage: '再び電源を入れるまでクラウドは停止します。Raspberry Pi には電源ボタンがないため、電源を入れるには電源ケーブルを抜き差しする必要があります。外出先からは電源を入れられません。',
  poweroffConfirm: 'シャットダウン',
  transfersWarning: '転送中の処理があります。デバイスが復帰すると再開されます。',
  failed: '命令を送信できませんでした',
  rebooting: '再起動中…',
  rebootingHint: '1〜2 分かかります。デバイスが復帰すると、このページは自動で再読み込みされます。',
  rebootSlow: '通常より時間がかかっています。復帰しない場合は、デバイスの電源を確認してください。',
  back: 'デバイスが起動しました',
  poweringOff: 'デバイスをシャットダウン中…',
  poweredOff: 'デバイスをシャットダウンしました',
  poweredOffHint: 'Raspberry Pi の緑色のランプが点滅しなくなったら、電源を抜いても安全です。電源を入れるには、電源ケーブルを再び接続してください。',
  close: '閉じる',
} satisfies Translation<typeof source>;
