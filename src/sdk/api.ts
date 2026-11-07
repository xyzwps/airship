import type { AirshipBridge, AppApi, AppId } from '@airship/contract'

/**
 * 构造某应用窗口的 API：桥 + 这个应用自己的身份。
 *
 * `AppApi` 这个类型住在 `@airship/contract`（它是契约的一部分，共享包也要用）；
 * 这里只留"怎么造出来"——读 `window.airship` 并补上 id。
 * id 只给应用做显示与日志用，不参与任何权限判定：
 * 身份是壳按窗口的 `event.sender` 反查出来的，应用侧根本没有"传 id"这个动作。
 */

/**
 * 由 SDK 宿主调用。桥不存在就是 preload 没加载成功——
 * 宁可在这里喊出来，也不要用可选链把它吞成一次空操作（这个坑踩过，见 AGENTS.md）。
 */
export function createAirshipApi(
  id: AppId,
  hooks?: { onWindowTitle?(title: string | null): void }
): AppApi {
  const bridge = (globalThis as { airship?: AirshipBridge }).airship
  if (!bridge) {
    throw new Error(
      `window.airship 不存在（应用 ${id}）：这个包不是由 airship 壳装的，或 preload 没加载成功。` +
        '正常入口是壳按 `airship://<id>/index.html` 开窗口；直接在浏览器里打开这份 html 是跑不起来的。'
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
