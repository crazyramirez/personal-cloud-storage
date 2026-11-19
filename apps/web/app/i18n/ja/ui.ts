import type { Translation } from '~/utils/i18n';
import type source from '../ui';

export default {
  actions: '操作',
  couldNotComplete: '完了できませんでした',
  forbiddenChars: '次の文字は使用できません: \\ / : * ? " < > |',
  saving: '保存中…',
  dismissToast: '通知を閉じる',
  folderLoadFailed: 'フォルダを読み込めませんでした',
  folderCreateFailed: 'フォルダを作成できませんでした',
  currentFolder: '現在のフォルダ',
  noSubfolders: 'サブフォルダはありません。',
  newFolderName: '新しいフォルダの名前',
  create: '作成',
  forbiddenFolder: 'このフォルダは選択できません。対象の項目そのものか、その中にあるフォルダです。',
  newFolder: '新規フォルダ',
  preparingDownload: '「{name}」を準備中…',
  downloadingPercent: '「{name}」をダウンロード中… {pct}%',
  downloadingBytes: '「{name}」をダウンロード中… {size}',
  downloadReady: '「{name}」の準備ができました',
  saveShare: '保存…',
  downloadFailed: 'ダウンロードできませんでした',
  downloadDefaultName: 'ファイル',
} satisfies Translation<typeof source>;
