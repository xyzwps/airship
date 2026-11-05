/**
 * 事件投递路由。
 *
 * 抽成纯函数是为了能被测试：窗口化真正买到的东西是隔离，
 * 而隔离的最后一环就是"子进程进度、托盘点击这类事件只回到归属那个窗口"。
 * 这条规则埋在 BrowserWindow 调用里就没法验证，拎出来就能。
 */

export interface WindowRef {
  contentsId: number
  owner: string
}

/** 某个归属的窗口；没有（应用没开）就返回空数组——事件被丢弃，不广播 */
export function targetsFor(owner: string, windows: WindowRef[]): number[] {
  return windows.filter((w) => w.owner === owner).map((w) => w.contentsId)
}

/** 广播目标：所有窗口 */
export function allTargets(windows: WindowRef[]): number[] {
  return windows.map((w) => w.contentsId)
}
