import { useEffect, useState, type JSX } from 'react'
import { entriesAvailableOn } from '../apps'
import { Titlebar } from './Titlebar'
import { useTheme, THEME_MODES, type ThemeMode } from './theme'
import { useReportShotReady } from './shot'
import type { PlatformId } from '@shared/protocol'

/**
 * 启动器。
 *
 * 就是一张应用格子：图标 + 名字，点开各自独立窗口。
 * 说明文字、能力标签、壳状态这些一概不放——要看的东西在应用自己里看。
 *
 * 应用列表直接读渲染侧的注册表（它已经急切加载了各应用的图标模块），
 * 不再绕一趟主进程；只有当前平台用得了的应用进格子。
 */
export function Launcher(): JSX.Element {
  const { mode, setMode } = useTheme()
  const [platform, setPlatform] = useState<PlatformId | 'unknown' | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.airshipShell
      .currentPlatform()
      .then((p) => alive && setPlatform(p))
      .catch(() => alive && setPlatform('unknown'))
    return () => {
      alive = false
    }
  }, [])

  const entries = platform === null ? [] : entriesAvailableOn(platform)

  useReportShotReady([entries.length])

  const open = (id: string): void => {
    setError(null)
    void window.airshipShell.openApp(id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  return (
    <div className="launcher">
      <Titlebar />

      <div className="launcher__body">
        <div className="launcher__bar">
          <select
            className="select launcher__theme"
            value={mode}
            onChange={(e) => setMode?.(e.target.value as ThemeMode)}
            aria-label="主题"
          >
            {THEME_MODES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="tiles">
          {entries.map(({ meta, iconUrl }) => (
            <button
              key={meta.id}
              type="button"
              className="tile"
              onClick={() => open(meta.id)}
            >
              <span className="tile__icon">
                <img src={iconUrl} alt="" className="tile__glyph" />
              </span>
              <span className="tile__name">{meta.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
