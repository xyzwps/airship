import type { AppMeta } from '@airship/contract'

/**
 * 应用清单：这个应用对外形状的全部。
 *
 * 只写"这个应用自己的事实"。三样东西被明确驳回过，别加回来：
 *   `iconPath`——图标是包根那一张文件，写路径等于假定它必须是某种形状；
 *   `order`——顺序是应用之间的关系，单个应用决定不了自己的排位；
 *   窗口状态的记忆——尺寸由 defaultWidth/defaultHeight 定，改了必须立刻生效。
 *
 * `capabilities` 是唯一授权面：没声明的一律拒绝，界面上也就不会出现"记住上次"这种东西。
 * 用不到就写 `[]`（生命游戏就是这么起的）。用了 `api.settings.` / `api.proc.` 这些域
 * 就必须声明对应能力，AP-011 会扫源码核对。
 */
export const app: AppMeta = {
  id: 'CHANGE_ME',
  name: '显示名',
  description: '一句话说清它是干什么的',
  capabilities: []
}
