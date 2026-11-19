import type { Translation } from '~/utils/i18n';
import type source from '../errors';

export default {
  VALIDATION_FAILED: 'リクエストが無効です',
  INVALID_PATH: 'パスが無効です',
  INVALID_NAME: '名前が無効です',
  UNAUTHENTICATED: 'セッションの有効期限が切れました。もう一度サインインしてください',
  FORBIDDEN: 'この操作を行う権限がありません',
  NOT_FOUND: '見つかりません（移動または削除された可能性があります）',
  CONFLICT: '既存の項目と競合しています',
  OFFSET_MISMATCH: 'アップロードの同期がずれました。再開します',
  PRECONDITION_FAILED: 'その間に項目が変更されました',
  PAYLOAD_TOO_LARGE: 'サイズが大きすぎます',
  UNSUPPORTED_MEDIA: 'この種類のファイルは表示できません',
  RANGE_NOT_SATISFIABLE: '要求された範囲が無効です',
  CHECKSUM_MISMATCH: 'ファイルが破損した状態で届きました。アップロードをやり直します',
  LOCKED: '別の操作で使用中です',
  RATE_LIMITED: '試行回数が多すぎます。しばらくお待ちください',
  INTERNAL: 'サーバー内部エラー',
  STORAGE_UNAVAILABLE: 'ディスクを使用できません',
  INSUFFICIENT_STORAGE: 'ディスクがいっぱいです',
  NETWORK: 'サーバーに接続できません',
  TIMEOUT: 'サーバーが応答しません。数秒後にもう一度お試しください。',
  httpStatus: 'エラー {status}',
} satisfies Translation<typeof source>;
