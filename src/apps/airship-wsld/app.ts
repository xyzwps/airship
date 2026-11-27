import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  name: 'WSLD',
  description: 'WSL 容器与镜像的图形外壳：看列表、起停删、读日志、编排 run 命令',
  // 一切数据与动作都是从 wslc.exe 问来的：清单里不声明，runtime 就不给路径、proc 也不认它
  tools: ['wslc'],
  // 它只认 wslc.exe，别的平台上根本跑不起来
  platforms: ['windows'],
  // 两栏版心自己控制留白
  flush: true
}
