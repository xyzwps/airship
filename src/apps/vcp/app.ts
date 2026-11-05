import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'vcp',
  name: 'vcp',
  description: 'FFmpeg 编排台：选流、加处理链、看命令、跑队列',
  accent: '#e0834a',
  capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'proc', 'notify', 'clipboard', 'log'],
  // 转码全靠它：声明了壳才给路径，proc 白名单也才认它
  tools: ['ffmpeg'],
  // 编排台自己控制留白，不要壳给的内容区内边距
  flush: true,
}
