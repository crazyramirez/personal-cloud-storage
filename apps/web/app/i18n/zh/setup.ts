import type { Translation } from '~/utils/i18n';
import type source from '../setup';

export default {
  pageTitle: '初始设置 · Personal Cloud',
  title: '创建所有者账户',
  lead: '此账户拥有你的云的全部访问权限。密码无法通过电子邮件找回，请妥善保管。',
  code: '设置代码',
  codeHelp: '服务器在安装时显示的一次性代码（24 小时内有效），用于证明你能访问 Raspberry Pi。',
  username: '用户名',
  usernameHelp: '可使用字母、数字、句点、连字符和下划线。',
  password: '密码',
  passwordHelp: '至少 {n} 个字符。一句容易记住的短语比带符号的单词更安全。',
  repeat: '确认密码',
  mismatch: '两次输入的密码不一致。',
  creating: '正在创建账户…',
  submit: '创建账户并登录',
  failed: '无法创建账户',
} satisfies Translation<typeof source>;
