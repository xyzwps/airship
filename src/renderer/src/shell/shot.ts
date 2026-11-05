import { useEffect, useState } from 'react'
import type { AppId } from '@shared/protocol'

/**
 * 截图模式辅助。
 *
 * 流程：主进程逐个发 shot:goto，渲染侧切到对应应用，
 * 等一帧 + 一个宏任务（让 lazy chunk 和字体落定），再报 shot:ready，
 * 主进程收到后 capturePage。
 *
 * 单窗口、不重载：file:// 下反复 loadFile 带 fragment 会 ERR_FAILED，
 * 而且重载会丢掉"应用常驻挂载"这个壳的既有行为。
 */

interface ShotCtl {
  ready(): void
  onGoto(cb: (app: string | null) => void): () => void
}

export function shotCtl(): ShotCtl | null {
  return (window as unknown as { __airshipShot?: ShotCtl }).__airshipShot ?? null
}

export const isShotMode = (): boolean => shotCtl() !== null

/** 等一个事件循环 + 一帧，确保 DOM 已经画完再截图 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
}

/** 订阅 shot:goto，返回退订函数 */
export function useShotGoto(cb: (app: AppId | null) => void): void {
  useEffect(() => {
    const ctl = shotCtl()
    if (!ctl) return
    return ctl.onGoto((app) => cb((app as AppId | null) ?? null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** 当前应用渲染完就报就绪。deps 变化（切应用）会重新报一次。 */
export function useShotReady(deps: unknown[]): void {
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

/** 给托盘徽标画带数字的位图，见 renderTrayIcon */
export { renderTrayIcon } from './trayIcon'
