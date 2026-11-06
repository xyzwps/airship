import { useEffect, useState } from 'react'
import type { ThemeSnapshot } from '@shared/protocol'

/**
 * 主题。
 *
 * 窗口化之后每个窗口是独立文档，所以主题不能各自为政：
 *   - 谁生效由壳决定，渲染侧只读 `airship.theme()` 并订阅 `theme:changed`；
 *   - "跟随系统"的实际结果由**启动器**用 matchMedia 算出来回报给壳，
 *     应用窗口不重复算，免得两个窗口对同一档给出不同结论。
 *
 * 用 <html data-theme> + CSS 变量落地，应用侧不各自实现配色。
 */

export type ThemeMode = ThemeSnapshot['mode']

/**
 * 三档的名字。启动器上那颗键按这个顺序循环：跟随系统 → 暗 → 亮 → 跟随系统。
 * 顺序是表现层的决定，写在一处，别散在按钮里。
 */
export const THEME_ORDER: ThemeMode[] = ['system', 'dark', 'light']

export const THEME_LABEL: Record<ThemeMode, string> = {
  system: '跟随系统',
  dark: '暗色',
  light: '亮色'
}

/** 点一下之后该落到哪一档 */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  const i = THEME_ORDER.indexOf(mode)
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function apply(snapshot: ThemeSnapshot): void {
  document.documentElement.dataset.theme = snapshot.resolved
  document.documentElement.style.colorScheme = snapshot.resolved
}

/** 首帧兜底：桥还没回话之前先按系统偏好画，避免白闪一下 */
function initial(): ThemeSnapshot {
  const resolved = prefersDark() ? 'dark' : 'light'
  return { mode: 'system', resolved }
}

export function useTheme(): {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  /** 只有启动器有；应用窗口里主题是只读的，调它会静默无效 */
  setMode?: (mode: ThemeMode) => void
} {
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(initial)

  useEffect(() => {
    let alive = true
    void window.airship
      .theme()
      .then((s) => alive && setSnapshot(s))
      .catch(() => undefined)

    const off = window.airship.on((event) => {
      if (event.kind === 'theme:changed' && alive) setSnapshot(event.value)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  useEffect(() => apply(snapshot), [snapshot])

  const shell = (globalThis as { airshipShell?: ShellThemeApi }).airshipShell

  const setMode = (mode: ThemeMode): void => {
    if (!shell) return
    // 'system' 这一档的实际亮暗由启动器算：主进程没有 matchMedia，不该去猜
    const hint = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : undefined
    void shell
      .setTheme(mode, hint)
      .then((s) => setSnapshot(s))
      .catch(() => undefined)
  }

  // 跟随系统时，系统偏好变了就重新走一次设置，让所有窗口一起跟上
  useEffect(() => {
    if (!shell || snapshot.mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => setMode('system'))
    return () => mq.removeEventListener('change', () => setMode('system'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shell, snapshot.mode])

  return { mode: snapshot.mode, resolved: snapshot.resolved, setMode: shell ? setMode : undefined }
}

interface ShellThemeApi {
  setTheme(mode: ThemeMode, hint?: 'light' | 'dark'): Promise<ThemeSnapshot>
}
