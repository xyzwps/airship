import { Suspense, useCallback, useEffect, useMemo, useState, type JSX } from 'react'
import { APP_MAP } from '@shared/registry'
import type { AppId } from '@shared/protocol'
import { APP_ENTRIES } from '../apps'
import { isAppId } from '../apps/types'
import { bindApi, type AppApi } from './useAppApi'
import { Home } from './Home'
import { Sidebar } from './Sidebar'
import { Titlebar } from './Titlebar'
import { useTheme, THEME_MODES, type ThemeMode } from './theme'
import { isShotMode, useShotGoto, useShotReady } from './shot'

/**
 * 壳。
 *
 * 职责只有四件：选哪个应用、给它一份已绑定身份的 api、
 * 提供标题栏和主题、记住上次停在哪儿。
 * 业务一律在应用里，壳不碰。
 *
 * 应用是常驻挂载的（切走只是隐藏），不是卸载重建——
 * 阅读器翻到第 200 页、vcp 跑着一条转码任务，切个应用不该丢状态。
 */
export function Shell(): JSX.Element {
  const { mode, setMode } = useTheme()
  const [active, setActive] = useState<AppId | null>(null)
  const [mounted, setMounted] = useState<Set<AppId>>(() => new Set())

  // 记住上次停在哪个应用；截图模式下不恢复，避免干扰逐个截图
  useEffect(() => {
    if (isShotMode()) return
    let alive = true
    void window.airship.settings.get<{ lastApp?: AppId | null }>('shell', 'ui', {}).then((v) => {
      if (!alive) return
      const last = v?.lastApp
      if (isAppId(last ?? null) && last) {
        setActive(last)
        setMounted((prev) => new Set(prev).add(last))
      }
    })
    return () => {
      alive = false
    }
  }, [])

  // 截图模式：主进程让切哪个就切哪个
  useShotGoto((app) => {
    setActive(app)
    if (app) setMounted((prev) => (prev.has(app) ? prev : new Set(prev).add(app)))
  })

  const pick = useCallback((id: AppId | null) => {
    setActive(id)
    if (id) setMounted((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    void window.airship.settings.set('shell', 'ui', { lastApp: id }).catch(() => undefined)
  }, [])

  // api 实例按应用缓存，避免每次渲染都重建一份
  const apis = useMemo(() => {
    const map = new Map<AppId, AppApi>()
    for (const id of Object.keys(APP_ENTRIES) as AppId[]) {
      map.set(id, bindApi(id))
    }
    return map
  }, [])

  const meta = active ? APP_MAP[active] : null

  // 截图模式：当前应用渲染完就通知主进程
  useShotReady([active, mounted.size])

  return (
    <div className="shell">
      <Titlebar here={meta?.name ?? null} />

      <Sidebar
        active={active}
        onPick={pick}
        footer={
          <>
            <div className="row">
              <span className="hint">主题</span>
              <select
                className="select"
                style={{ flex: 1, minWidth: 0 }}
                value={mode}
                onChange={(e) => setMode(e.target.value as ThemeMode)}
              >
                {THEME_MODES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <span className="hint" style={{ fontSize: 11 }}>
              数据在 userData 下，各应用互不可见
            </span>
          </>
        }
      />

      <main className="content">
        {active === null ? (
          <Home onOpen={pick} />
        ) : (
          [...mounted].map((id) => {
            const Entry = APP_ENTRIES[id]!
            const App = Entry.component
            return (
              <div
                key={id}
                className={`app-frame${Entry.flush ? ' app-frame--flush' : ''}`}
                style={{ display: active === id ? 'flex' : 'none' }}
              >
                <Suspense
                  fallback={
                    <div className="placeholder">
                      <div className="spinner" />
                    </div>
                  }
                >
                  <App api={apis.get(id)!} />
                </Suspense>
              </div>
            )
          })
        )}
      </main>
    </div>
  )
}
