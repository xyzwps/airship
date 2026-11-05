import { useCallback, useEffect, useState } from 'react'

/**
 * 主题。跟随系统 / 亮色 / 暗色三档，全局记忆。
 *
 * 用 <html data-theme> + CSS 变量落地，应用侧不用各自实现一套配色。
 * 墨读原来就是这个模型（书架/EPUB/PDF 同步换色），搬过来保持一致。
 */

export type ThemeMode = 'light' | 'dark' | 'system'

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' }
]

const STORAGE_KEY = 'airship:theme'

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode
}

function readInitial(): ThemeMode {
  // 首帧用 localStorage，避免闪一下默认主题再去问主进程
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* localStorage 不可用就用默认值 */
  }
  return 'system'
}

function apply(resolved: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}

export function useTheme(): {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
} {
  const [mode, setModeState] = useState<ThemeMode>(readInitial)
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => resolveTheme(readInitial()))

  // 跟主进程的设置对齐（壳级 settings），并持久化
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const stored = await window.airship.settings.get<{ mode?: ThemeMode }>('shell', 'theme', {})
        if (!cancelled && stored?.mode) {
          setModeState(stored.mode)
        }
      } catch {
        /* 主进程没准备好就用本地值 */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const next = resolveTheme(mode)
    setResolved(next)
    apply(next)
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* 存不下就算了，不影响本次会话 */
    }
    void window.airship?.settings.set('shell', 'theme', { mode }).catch(() => undefined)
  }, [mode])

  // 系统主题变化时，跟随系统这一档要实时跟着变
  useEffect(() => {
    if (mode !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (): void => {
      const next = resolveTheme('system')
      setResolved(next)
      apply(next)
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mode])

  const setMode = useCallback((next: ThemeMode) => setModeState(next), [])

  return { mode, resolved, setMode }
}
