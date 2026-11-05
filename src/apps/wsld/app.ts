import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'wsld',
  name: '容器台',
  description: 'WSL 容器与镜像的图形外壳：看列表、起停删、读日志',
  accent: '#3f7f9c',
  capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'proc', 'notify', 'clipboard', 'log'],
  // 一切数据与动作都是从 wslc.exe 问来的：不在清单里声明，壳就不给路径、proc 也不认它
  tools: ['wslc'],
  // 它只认 wslc.exe，别的平台上根本跑不起来
  platforms: ['windows'],
  // 两栏版心自己控制留白
  flush: true
}
