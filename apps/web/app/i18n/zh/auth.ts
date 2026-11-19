import type { Translation } from '~/utils/i18n';
import type source from '../auth';

export default {
  pageTitle: '登录 · Personal Cloud',
  title: '登录',
  subtitle: '访问你的个人云。',
  withPasskey: '使用通行密钥登录',
  passkeyHint: '面容 ID、触控 ID、Windows Hello 或手机指纹。',
  orPassword: '或使用密码',
  username: '用户名',
  password: '密码',
  checking: '正在验证…',
  submit: '登录',
  passkeyUnsupportedBefore: '要使用面容 ID 或 Windows Hello 登录，请在安装证书后打开 ',
  passkeyUnsupportedAfter: '（不要使用 IP 地址）。',
  loginFailed: '无法登录',
  thisDevice: '此设备',
  cancelled: '操作已取消',
  passkeyTimeout: '请求已取消或超时，请重试。',
  passkeyExists: '此设备已为你的账户注册了通行密钥。',
  passkeyInsecure: '浏览器不允许在此使用通行密钥：请安装证书后，通过 HTTPS 和 .local 名称打开应用。',
  passkeyFailed: '无法完成请求',
} satisfies Translation<typeof source>;
