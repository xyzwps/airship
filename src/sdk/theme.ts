import { useEffect, useState } from 'react'
import type { ThemeSnapshot } from '@airship/contract'

/**
 * 主题。
 *
 * 每个应用各记各的档，落在它自己那份设置文件里（runtime 不持有全局主题，
 * 也没有"别的窗口跟着换"这回事——一个应用只有一个窗口）。
 * 渲染侧读 `airship.theme()`，改档走 `airship.setTheme()`；
 * "跟随系统"的实际亮暗由**本窗口**用 matchMedia 算好传进去——主进程没有 matchMedia，不该去猜。
 *
 * 同一个文档里可能有多处 useTheme（宿主一处、应用组件拿 resolved 画布又一处）：
 * 挂载时各读各的，但**改档一次，本文档所有实例一起更新**——靠模块级订阅者表，
 * 不靠 runtime 广播（一个应用只有一个窗口，没有跨窗口同步这回事）。
 *
 * 用 <html data-theme> + CSS 变量落地，应用侧不各自实现配色。
 */

export type ThemeMode = ThemeSnapshot['mode']

/**
 * 三档的名字。标题栏上那颗键按这个顺序循环：跟随系统 → 暗 → 亮 → 跟随系统。
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

/* ---------------- 本文档内的同步 ---------------- */

const subscribers = new Set<(s: ThemeSnapshot) => void>()

/** 最近一次落定的快照：只用来判"系统偏好变了要不要跟"，不当挂载初值（各实例自己读桥） */
let latest: ThemeSnapshot | null = null

function publish(snapshot: ThemeSnapshot): void {
  latest = snapshot
  for (const fn of [...subscribers]) fn(snapshot)
}

/** 改本应用的主题档，立刻生效；不走 settings 面（窗口观感族） */
function setMode(mode: ThemeMode): void {
  // 'system' 这一档的实际亮暗由本窗口算：主进程没有 matchMedia，不该去猜
  const hint = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : undefined
  void window.airship
    .setTheme(mode, hint)
    .then((s) => publish(s))
    .catch(() => undefined)
}

/** 系统偏好变了，跟随系统的那一档要重新走一次设置。整个文档只挂一条监听 */
let mqWired = false
function wireSystemPreference(): void {
  if (mqWired || typeof window === 'undefined') return
  mqWired = true
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (latest?.mode === 'system') setMode('system')
  })
}

export function useTheme(): {
  mode: ThemeMode
  resolved: 'light' | 'dark'
  setMode: (mode: ThemeMode) => void
} {
  const [snapshot, setSnapshot] = useState<ThemeSnapshot>(initial)

  useEffect(() => {
    let alive = true
    const sync = (s: ThemeSnapshot): void => {
      if (alive) setSnapshot(s)
    }
    subscribers.add(sync)
    wireSystemPreference()
    void window.airship
      .theme()
      .then((s) => {
        if (!alive) return
        latest = s
        setSnapshot(s)
      })
      .catch(() => undefined)
    return () => {
      alive = false
      subscribers.delete(sync)
    }
  }, [])

  useEffect(() => apply(snapshot), [snapshot])

  return { mode: snapshot.mode, resolved: snapshot.resolved, setMode }
}