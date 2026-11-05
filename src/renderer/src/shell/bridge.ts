/**
 * 壳的 API 面在测试/预加载缺失时的兜底。
 *
 * 只有 vitest 跑纯逻辑单测时会走到这里（那种测试不该碰 Electron）。
 * 正常在 Electron 里跑，window.airship 一定存在，不存在就直接抛错——
 * 静默兜底会让"能力没接上"这类问题藏到很深才暴露。
 */
import type { AirshipBridge } from '@shared/protocol'

export function requireBridge(): AirshipBridge {
  const bridge = (globalThis as { airship?: AirshipBridge }).airship
  if (!bridge) {
    throw new Error(
      'window.airship 不存在：preload 没有加载成功。' +
        '检查 electron.vite.config.ts 的 preload 入口和 BrowserWindow 的 webPreferences.preload 路径。'
    )
  }
  return bridge
}

export const isElectron = typeof window !== 'undefined' && 'airship' in window
