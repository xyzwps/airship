import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  id: 'airship-life-game',
  name: 'Life Game',
  description: '在 100 / 200 / 300 的网格上跑康威生命游戏，经典图形随手放，格子自己画',
  // 一件都不声明：这应用不需要文件、不需要设置、不需要通知，画完就走。
  // 不声明就拿不到，界面上也就没有"记住上次那张图"这种反直觉的东西
  // （判据见 src/runtime/specs/runtime.md SH-015：runtime 不记窗口状态，配置改了必须立刻生效）。
  capabilities: [],
  flush: true,
  defaultWidth: 1000,
  defaultHeight: 720
}
