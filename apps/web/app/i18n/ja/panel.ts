import type { Translation } from '~/utils/i18n';
import type source from '../panel';

export default {
  pageTitle: 'ダッシュボード · Personal Cloud',
  title: 'ダッシュボード',
  subtitle: 'パーソナルクラウドの状態',

  // Aviso de copia de seguridad
  backupAria: '注意: まだバックアップがありません',
  backupTitle: 'まだバックアップがありません',
  backupNoteAria: 'バックアップに関するお知らせ',
  backupBody: 'ファイルはこのディスクにしか保存されていません。故障したり紛失したりすると、ほかにコピーはありません。外付け USB ディスクを接続し、「設定」→「バックアップ」で有効にしてください。',
  backupOkTitle: 'バックアップは最新です',
  backupOkBody: '前回のバックアップ: {when}。',
  backupOldTitle: 'バックアップが必要です',
  backupOldBody: '前回のバックアップは {when} です。バックアップディスクを接続して最新の状態にしてください。',
  backupNeverBody: 'バックアップディスクはありますが、まだバックアップが作成されていません。接続して最初のバックアップを作成してください。',
  backupOpen: 'バックアップを開く',

  // Disco
  disk: 'データディスク',
  free: '{size} 空き',
  usedOf: '{total} 中 {used} 使用済み',
  usedShort: '使用中',
  checkingDisk: 'ディスクを確認中…',
  format: 'フォーマット',
  device: 'デバイス',
  reserve: '予約領域',
  reserveHint: '{size}: これを下回るとアップロードが停止されます',
  checked: '確認日時',

  // Transferencias
  transfers: 'アップロード',
  activeCount: (p) => (Number(p.n) === 0 ? '実行中のアップロードはありません' : `${p.n} 件実行中`),
  finishedCount: (p) => `このセッションで ${p.n} 件完了`,
  viewTransfers: 'アップロードを表示',

  // Acceso y seguridad
  access: 'アクセスとセキュリティ',
  scope: '範囲',
  scopeValue: 'ローカルネットワークと Tailscale（プライベート VPN）のデバイス · インターネットには公開されません',
  viaTailscale: ' · 現在 Tailscale 経由で接続中',
  connection: '接続',
  encryptedTailscale: '暗号化（Tailscale の有効な証明書による HTTPS）',
  encryptedOwn: '暗号化（サーバー独自の証明書による HTTPS）',
  unencrypted: '暗号化なし（HTTP）: テスト用途にのみ使用してください',
  trash: 'ゴミ箱',
  viewTrash: 'ゴミ箱を表示',
  trashEmpty: '空',
  items: (p) => `${p.n} 個の項目`,
} satisfies Translation<typeof source>;
