import type { Translation } from '~/utils/i18n';
import type source from '../panel';

export default {
  pageTitle: '概览 · Personal Cloud',
  title: '概览',
  subtitle: '你的个人云状态',

  // Aviso de copia de seguridad
  backupAria: '提醒：你还没有备份',
  backupTitle: '你还没有备份',
  backupNoteAria: '备份提醒',
  backupBody: '此磁盘是保存你文件的唯一位置：一旦损坏或丢失，就没有其他副本。请连接一个外置 USB 磁盘，然后在“设置”→“备份”中启用备份。',
  backupOkTitle: '备份是最新的',
  backupOkBody: '上次备份：{when}。',
  backupOldTitle: '需要备份',
  backupOldBody: '上次备份时间为 {when}。连接备份磁盘以更新备份。',
  backupNeverBody: '你已设置备份磁盘，但尚未进行任何备份。连接该磁盘以进行首次备份。',
  backupOpen: '打开备份',

  // Disco
  disk: '数据磁盘',
  free: '可用 {size}',
  usedOf: '已用 {used}，共 {total}',
  usedShort: '已使用',
  checkingDisk: '正在检查磁盘…',
  format: '格式',
  device: '设备',
  reserve: '保留空间',
  reserveHint: '{size}：低于此值将阻止上传',
  checked: '已检查',

  // Transferencias
  transfers: '上传',
  activeCount: (p) => (Number(p.n) === 0 ? '没有正在进行的上传' : `${p.n} 个正在进行`),
  finishedCount: (p) => `本次会话已完成 ${p.n} 个`,
  viewTransfers: '查看上传',

  // Acceso y seguridad
  access: '访问与安全',
  scope: '范围',
  scopeValue: '局域网和你的 Tailscale 设备（私有 VPN）· 从不向互联网开放',
  viaTailscale: ' · 你当前通过 Tailscale 访问',
  connection: '连接',
  encryptedTailscale: '已加密（使用有效 Tailscale 证书的 HTTPS）',
  encryptedOwn: '已加密（使用服务器自有证书的 HTTPS）',
  unencrypted: '未加密 (HTTP)：仅用于测试',
  trash: '回收站',
  viewTrash: '查看回收站',
  trashEmpty: '空',
  items: (p) => `${p.n} 个项目`,
} satisfies Translation<typeof source>;
