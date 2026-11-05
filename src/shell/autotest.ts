import { useEffect } from 'react'
import { isShotMode } from './shot'

/**
 * 应用侧的自动化验证钩子。
 *
 * 之前这套东西在每个应用里各抄了一遍（类型强转 + 注册时序 + 报就绪），
 * 四个应用 26 行重复代码。约定要求"应用只写业务"，所以把它收下来：
 *
 *   useAppAutotest('vcp', async (path) => { ...打开这个文件... })
 *
 * 帮助函数负责三件事，顺序不能换：
 *   1. 把 path 授权给本应用读（截图模式下才有这条通道，正常启动时整个钩子不存在）
 *   2. 调用应用的处理器
 *   3. 注册完立刻报 listenerReady —— 主进程等这个才推事件，
 *      否则事件会砸在一个还没挂载的 lazy chunk 上（这个坑踩过，见 shot.ts）
 *
 * 只在截图模式生效：非截图模式下它什么都不做，应用代码里不留分支。
 */

interface ShotCtlInternal {
  ready(): void
  onGoto(cb: (app: string | null) => void): () => void
  onAutotest?(cb: (payload: { app: string; path: string }) => void): () => void
  grantRead?(app: string, path: string): Promise<unknown>
  listenerReady?(app: string): void
}

function internalCtl(): ShotCtlInternal | null {
  return (window as unknown as { __airshipShot?: ShotCtlInternal }).__airshipShot ?? null
}

export function useAppAutotest(
  appId: string,
  handler: (path: string) => void | Promise<void>,
  onError?: (message: string) => void
): void {
  useEffect(() => {
    if (!isShotMode()) return
    const ctl = internalCtl()
    if (!ctl?.onAutotest || !ctl.grantRead || !ctl.listenerReady) return

    ctl.onAutotest((payload) => {
      if (payload.app !== appId) return
      void (async () => {
        if (payload.path) await ctl.grantRead!(appId, payload.path)
        await handler(payload.path)
      })().catch((err: unknown) => {
        onError?.(err instanceof Error ? err.message : String(err))
      })
    })

    ctl.listenerReady(appId)
    // 只在挂载时注册一次：handler 闭包里的依赖由调用方保证稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId])
}
