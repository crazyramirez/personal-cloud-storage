import type { Translation } from '~/utils/i18n';
import type source from '../nav';

export default {
  mainNav: '主导航',
  version: '版本 {v}',
  tabNav: '导航',
  remote: '通过 Tailscale',
  local: '局域网',
  dashboard: '概览',
  files: '文件',
  trash: '回收站',
  activity: '活动',
  settings: '设置',
  lightTheme: '切换到浅色主题',
  darkTheme: '切换到深色主题',
  signOut: '退出登录',
  tagline: '你的云，存在你自己的磁盘上',
} satisfies Translation<typeof source>;
