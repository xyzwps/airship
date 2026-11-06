import type { AirshipBridge, AppApi, AppId } from '@shared/protocol'

/**
 * 构造某应用窗口的 API。
 *
 * AppApi 这个类型本身住在 @shared/protocol（它是契约的一部分，共享包也要用）；
 * 这里只留"怎么造出来"这件事——读 window.airship 并补上 id。
 * id 只给应用做显示与日志用，不参与任何权限判定。
 */

/** 由应用宿主构造：{ id, ...window.airship } */
export function makeAppApi(
  id: AppId,
  hooks?: { onWindowTitle?(title: string | null): void }
): AppApi {
  const bridge = (globalThis as { airship?: AirshipBridge }).airship
  if (!bridge) {
    throw new Error(
      'window.airship 不存在：preload 没有加载成功。' +
        '检查 electron.vite.config.ts 的 preload 入口和窗口的 webPreferences.preload 路径。'
    )
  }
  const api = { id, ...bridge } as AppApi
  if (hooks?.onWindowTitle) {
    const setTitle = api.window.setTitle.bind(api.window)
    api.window = {
      ...api.window,
      setTitle: async (title: string | null) => {
        hooks.onWindowTitle?.(title && title.trim() ? title.trim() : null)
        await setTitle(title)
      }
    }
  }
  return api
}
