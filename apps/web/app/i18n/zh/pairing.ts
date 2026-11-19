import type { Translation } from '~/utils/i18n';
import type source from '../pairing';

export default {
  title: '电脑备份',
  intro: '你的电脑可以通过 DEV Backup Studio 将备份保存到云端。只需一个代码即可连接，无需输入密码。',
  connect: '连接电脑',
  newCode: '换一个代码',
  cancel: '作废',
  codeLabel: '连接代码',
  step1: '在电脑上打开 DEV Backup Studio。',
  step2: '点击“连接到我的云”。',
  step3: '输入此代码。',
  expires: ({ min }) => `${min} 分钟后过期，仅可使用一次。`,
  expired: '代码已过期。',
  where: ({ host, share }) => `备份保存在云端的“${share}”文件夹中（\\\\${host}\\${share}）。`,
  unavailable: '此设备未安装网络文件夹。要启用它，请在服务器上运行：sudo bash /opt/pcloud/current/deploy/linux/setup/pcloud-install-smb.sh --execute',
  failed: '无法创建代码',
  copied: '代码已复制',
  copy: '复制代码',
} satisfies Translation<typeof source>;
