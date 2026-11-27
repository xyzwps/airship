import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  name: 'Life Game',
  description: '在 100 / 200 / 300 的网格上跑康威生命游戏，经典图形随手放，格子自己画',
  // 不碰设置、不碰文件：界面上也就没有"记住上次那张图"这种反直觉的东西
  // （判据见 src/runtime/specs/runtime.md SH-015：runtime 不记窗口状态，配置改了必须立刻生效）。
  flush: true,
  defaultWidth: 1000,
  defaultHeight: 720
}
