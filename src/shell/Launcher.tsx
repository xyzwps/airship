import { useCallback, useEffect, useState, type JSX } from 'react'
import type { AppMeta, } from '@shared/app'
import { AppIcon } from './AppIcon'
import { Titlebar } from './Titlebar'
import { useTheme, THEME_MODES, type ThemeMode } from './theme'
import { useReportShotReady } from './shot'

/**
 * 启动器。
 *
 * 窗口化之后壳自己只剩这一件事：列出应用、点开一个独立窗口、给壳级诊断。
 * 它不再承载任何应用内容，所以也没有侧栏——应用列表就是主界面。
 */
export function Launcher(): JSX.Element {
  const { mode, setMode } = useTheme()
  const [apps, setApps] = useState<AppMeta[]>([])
  const [open, setOpen] = useState<string[]>([])
  const [ffmpeg, setFfmpeg] = useState<string | null | undefined>(undefined)
  const [root, setRoot] = useState('')
  const [version, setVersion] = useState('')

  const refreshOpen = useCallback(() => {
    void window.airshipShell.openApps().then(setOpen).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    void window.airshipShell.apps().then((list) => alive && setApps(list)).catch(() => undefined)
    void window.airshipShell.ffmpegPath().then((p) => alive && setFfmpeg(p)).catch(() => undefined)
    void window.airshipShell.rootPaths().then((p) => {
      if (!alive) return
      setRoot(p.root)
      setVersion(p.shellVersion)
    }).catch(() => undefined)
    refreshOpen()
    return () => {
      alive = false
    }
  }, [refreshOpen])

  // 应用窗口关掉后，"在跑"标记要跟着掉
  useEffect(() => {
    const off = window.airshipShell.on(() => refreshOpen())
    const t = setInterval(refreshOpen, 2000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refreshOpen])

  useReportShotReady([apps.length])

  const openApp = (id: string): void => {
    void window.airshipShell.openApp(id).then(refreshOpen).catch(() => undefined)
  }

  return (
    <div className="launcher">
      <Titlebar />

      <div className="launcher__body">
        <header className="launcher__head">
          <div>
            <h1 className="launcher__title">飞船</h1>
            <p className="launcher__sub">一个壳，里面装着自用的几个应用。点开各自独立窗口，互不影响。</p>
          </div>
          <div className="row">
            <span className="hint">主题</span>
            <select
              className="select"
              value={mode}
              onChange={(e) => setMode?.(e.target.value as ThemeMode)}
            >
              {THEME_MODES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="launcher__grid">
          {apps.map((meta) => {
            const running = open.includes(meta.id)
            return (
              <button
                key={meta.id}
                type="button"
                className="appcard"
                style={{ ['--nav-accent' as string]: meta.accent }}
                onClick={() => openApp(meta.id)}
              >
                <div className="appcard__head">
                  <AppIcon meta={meta} className="appcard__icon" />
                  <span className="appcard__name">{meta.name}</span>
                  {running && <span className="chip chip--ok">在跑</span>}
                </div>
                <span className="appcard__desc">{meta.description}</span>
                <div className="appcard__caps">
                  {meta.capabilities.map((c) => (
                    <span key={c} className="cap">
                      {c}
                    </span>
                  ))}
                  {meta.sharedNamespaces?.map((ns) => (
                    <span key={ns} className="cap">
                      shared:{ns}
                    </span>
                  ))}
                </div>
              </button>
            )
          })}
        </div>

        <div className="card launcher__status">
          <h2 className="card__title">壳状态</h2>
          <div className="field-grid">
            <label>ffmpeg</label>
            <div className="row">
              {ffmpeg === undefined ? (
                <span className="hint">探测中…</span>
              ) : ffmpeg ? (
                <>
                  <span className="chip chip--ok">可用</span>
                  <span className="mono hint" title={ffmpeg}>{ffmpeg.split(/[\\/]/).pop()}</span>
                </>
              ) : (
                <>
                  <span className="chip chip--bad">没找到</span>
                  <span className="hint">vcp 不可用</span>
                </>
              )}
            </div>

            <label>数据目录</label>
            <span className="mono hint selectable" title={root}>{root}</span>

            <label>应用</label>
            <span className="hint">{apps.length} 个注册，{open.length} 个开着</span>

            <label>版本</label>
            <span className="mono hint">{version}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
