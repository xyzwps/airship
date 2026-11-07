/**
 * airship SDK —— 应用唯一该引的那一面。
 *
 * 一个 airship 包 = 一个自持的 html 文档，它从壳拿到的东西全在这里：
 *
 *   createAirshipApp({ meta, component, icon })   装进自己的文档（标题栏、主题、留白、占位）
 *   useTheme() · IconButton · Titlebar            壳的观感，应用不另调一套配色
 *   markPerf() · useAppAutotest()                 验证工装：耗时打点与自动导入
 *   renderTrayIcon()                              托盘徽标的位图怎么出
 *   AIRSHIP_CSP                                   入口 html 里那一条 CSP
 *
 * **应用不许引 `src/shell/` 下的任何东西**（AP-013 守着）。
 * 这条界线存在的理由：包要能脱离这个仓库被装进另一份壳里跑，
 * 一旦应用直连壳的实现，"包自持"就是假的。
 *
 * 契约本身（能调用什么、拿到什么）住在 `@airship/contract`，SDK 只是把它**接上界面**；
 * 两边都在这个仓库里，将来 SDK 独立发布时这一层就是发布物。
 */

export { createAirshipApp, AirshipRoot, type AirshipAppOptions } from './host.tsx'
export { createAirshipApi } from './api.ts'
export { Titlebar } from './Titlebar.tsx'
export { IconButton, Glyph, type IconName } from './IconButton.tsx'
export { useTheme, THEME_ORDER, THEME_LABEL, nextThemeMode, type ThemeMode } from './theme.ts'
export { markPerf, shotCtl, isShotMode, nextFrame, useReportShotReady } from './shot.ts'
export { useAppAutotest } from './autotest.ts'
export { renderTrayIcon } from './trayIcon.ts'
export { AIRSHIP_CSP } from './csp.ts'
