import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  name: 'FFmpeg',
  description: 'FFmpeg 编排台：选流、加处理链、看命令、跑队列',
  // 编排台自己控制留白，不要 runtime 给的内容区内边距
  flush: true,
}
