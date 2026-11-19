import type { Translation } from '~/utils/i18n';
import type source from '../errors';

export default {
  VALIDATION_FAILED: '请求无效',
  INVALID_PATH: '路径无效',
  INVALID_NAME: '名称无效',
  UNAUTHENTICATED: '你的会话已过期，请重新登录',
  FORBIDDEN: '你无权执行此操作',
  NOT_FOUND: '不存在（可能已被移动或删除）',
  CONFLICT: '与已存在的项目冲突',
  OFFSET_MISMATCH: '上传进度不同步，将自动继续',
  PRECONDITION_FAILED: '该项目在此期间已更改',
  PAYLOAD_TOO_LARGE: '内容过大',
  UNSUPPORTED_MEDIA: '无法显示此类型的文件',
  RANGE_NOT_SATISFIABLE: '请求的范围无效',
  CHECKSUM_MISMATCH: '文件传输时已损坏，将重新上传',
  LOCKED: '正被其他操作占用',
  RATE_LIMITED: '尝试次数过多，请稍候',
  INTERNAL: '服务器内部错误',
  STORAGE_UNAVAILABLE: '磁盘不可用',
  INSUFFICIENT_STORAGE: '磁盘已满',
  NETWORK: '无法连接到服务器',
  TIMEOUT: '服务器无响应。请过几秒后重试。',
  httpStatus: '错误 {status}',
} satisfies Translation<typeof source>;
