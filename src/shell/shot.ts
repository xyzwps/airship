import { useEffect } from 'react'

/**
 * 截图模式辅助。
 *
 * 窗口化之后流程变成：主进程开一个窗口 → 等这个窗口报就绪 → capturePage → 关掉 → 下一个。
 * 所以这里只剩两件事：报就绪、以及给应用用的 autotest 钩子（在 shell/autotest.ts）。
 *
 * 旧版靠 `#shot=<id>` 反复 loadFile 切换应用，那条路在 file:// 下会 ERR_FAILED；
 * 再早一版靠单窗口内切状态，又撞上 lazy chunk 还没挂载事件就发过来了。
 * 现在一个窗口一个应用，反而最简单。
 */

interface ShotCtl {
  ready(): void
  onAutotest?(cb: (payload: { app: string; path: string }) => void): () => void
  grantRead?(app: string, path: string): Promise<unknown>
  listenerReady?(app: string): void
  mark?(name: string): void
}

/**
 * 打一个性能标记（只在截图模式生效，正常启动是空操作）。
 *
 * 主进程按窗口归属收集，算的是"从这个应用窗口打开起"的相对毫秒，
 * 所以应用侧只需要在关键节点喊一声，不用自己算时间。
 */
export function markPerf(name: string): void {
  shotCtl()?.mark?.(name)
}

export function shotCtl(): ShotCtl | null {
  return (window as unknown as { __airshipShot?: ShotCtl }).__airshipShot ?? null
}

export const isShotMode = (): boolean => shotCtl() !== null

/** 等一个事件循环 + 一帧，确保 DOM 已经画完再截图 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

/** 本窗口渲染完了就报就绪，主进程收到才截图 */
export function useReportShotReady(deps: unknown[]): void {
  useEffect(() => {
    const ctl = shotCtl()
    if (!ctl) return
    let cancelled = false
    void nextFrame().then(() => {
      if (!cancelled) ctl.ready()
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
