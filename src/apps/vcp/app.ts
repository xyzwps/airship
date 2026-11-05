import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'vcp',
  name: 'vcp',
  description: 'FFmpeg 编排台：选流、加处理链、看命令、跑队列',
  // 一个方块被斜切成两段，代表转码前后
  iconPath: 'M3 4h18v16H3z M3 4l18 16 M9 4v16 M15 4v16',
  accent: '#e0834a',
  capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'proc', 'notify', 'clipboard', 'log'],
  // 编排台自己控制留白，不要壳给的内容区内边距
  flush: true,
  order: 1
}
