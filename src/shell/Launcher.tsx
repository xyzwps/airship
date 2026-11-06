import { useEffect, useState, type JSX } from 'react'
import { entriesAvailableOn } from '../apps'
import { Titlebar } from './Titlebar'
import { useTheme, THEME_LABEL, nextThemeMode, type ThemeMode } from './theme'
import { useReportShotReady } from './shot'
import type { PlatformId } from '@shared/protocol'

/**
 * 启动器。
 *
 * 就是一张应用格子：图标 + 名字，点开各自独立窗口。
 * 说明文字、能力标签、壳状态这些一概不放——要看的东西在应用自己里看。
 * 唯一的控件是右上角那颗主题键：三档循环，图标就是当前档。
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

  const next = nextThemeMode(mode)

  return (
    <div className="launcher">
      <Titlebar />

      <div className="launcher__body">
        <div className="launcher__bar">
          {/* 纯图标键：悬停说明与无障碍名称是强制项，念得出"现在哪档、点一下换成哪档" */}
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setMode?.(next)}
            aria-label={`主题：${THEME_LABEL[mode]}，点一下换成${THEME_LABEL[next]}`}
            title={`主题：${THEME_LABEL[mode]}（点一下换成${THEME_LABEL[next]}）`}
          >
            <ThemeGlyph mode={mode} />
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        <div className="tiles">
          {entries.map(({ meta, iconUrl }) => (
            <button key={meta.id} type="button" className="tile" onClick={() => open(meta.id)}>
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

/**
 * 三档各自的图形：跟随系统是半明半暗的圆（ Contrast 意思），暗是月牙，亮是太阳。
 * 都用 currentColor，跟着壳的文字色走，亮暗两档都不用另配色。
 */
function ThemeGlyph({ mode }: { mode: ThemeMode }): JSX.Element {
  const box = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  if (mode === 'dark') {
    // 月牙
    return (
      <svg {...box}>
        <path
          d="M10.2 1.6a6.4 6.4 0 1 0 4.2 8.6A5.2 5.2 0 0 1 10.2 1.6Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (mode === 'light') {
    // 太阳：中间一个圆，四周八道光芒
    return (
      <svg {...box}>
        <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M8 .9v1.9M8 13.2v1.9M.9 8h1.9M13.2 8h1.9M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
        </g>
      </svg>
    )
  }
  // 跟随系统：一半实心一半空的圆
  return (
    <svg {...box}>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" />
    </svg>
  )
}
