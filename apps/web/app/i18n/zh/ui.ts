import type { Translation } from '~/utils/i18n';
import type source from '../ui';

export default {
  actions: '操作',
  couldNotComplete: '无法完成操作',
  forbiddenChars: '不能包含：\\ / : * ? " < > |',
  saving: '正在保存…',
  dismissToast: '关闭通知',
  folderLoadFailed: '无法载入文件夹',
  folderCreateFailed: '无法创建文件夹',
  currentFolder: '当前文件夹',
  noSubfolders: '没有子文件夹。',
  newFolderName: '新文件夹名称',
  create: '创建',
  forbiddenFolder: '不能选择此文件夹：它是所选项目之一，或位于其中。',
  newFolder: '新建文件夹',
  preparingDownload: '正在准备“{name}”…',
  downloadingPercent: '正在下载“{name}”… {pct}%',
  downloadingBytes: '正在下载“{name}”… {size}',
  downloadReady: '“{name}”已准备就绪',
  saveShare: '保存…',
  downloadFailed: '无法下载',
  downloadDefaultName: 'file',
} satisfies Translation<typeof source>;
