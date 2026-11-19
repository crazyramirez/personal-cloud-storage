import type { Translation } from '~/utils/i18n';
import type source from '../power';

export default {
  title: '重启或关机',
  intro: '设备会在重启或关机前有序停止服务并卸载磁盘，不会丢失任何内容。',
  reboot: '重启',
  poweroff: '关机',
  unavailable: '此设备上未安装此功能：请重新安装（或运行 pcloud-install-power.sh --execute）。',
  rebootTitle: '要重启设备吗？',
  rebootMessage: '云将在 1 到 2 分钟内不可用。设备恢复后，此页面会自动重新载入。',
  rebootConfirm: '重启',
  poweroffTitle: '要关闭设备吗？',
  poweroffMessage: '在你重新开机之前，云将停止工作。Raspberry Pi 没有电源按钮：要开机，必须拔掉电源再重新接上，因此不在家时无法开机。',
  poweroffConfirm: '关机',
  transfersWarning: '有正在进行的传输：设备恢复后将继续。',
  failed: '无法发送指令',
  rebooting: '正在重启…',
  rebootingHint: '需要 1 到 2 分钟。设备恢复后，此页面会自动重新载入。',
  rebootSlow: '耗时比平常长。如果一直没有恢复，请检查设备的电源。',
  back: '设备已恢复运行',
  poweringOff: '正在关闭设备…',
  poweredOff: '设备已关闭',
  poweredOffHint: '当 Raspberry Pi 的绿灯停止闪烁后，即可拔掉电源。要开机，请重新接上电源。',
  close: '关闭',
} satisfies Translation<typeof source>;
