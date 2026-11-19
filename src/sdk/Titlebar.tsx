import { useEffect, useState, type JSX } from 'react'
import { THEME_LABEL, nextThemeMode, useTheme, type ThemeMode } from './theme.ts'

/**
 * 自绘标题栏。窗口是 frame:false，所以最小化/最大化/关闭得自己画。
 * 整条是可拖拽区（CSS 里的 -webkit-app-region: drag），按钮那一块显式排除。
 *
 * 主题键也在这条上：每个应用各改各的档（措辞与三档循环照搬原来启动器那颗），
 * 改完只影响本应用——runtime 不持有全局主题。
 */
export function Titlebar({ here, center, icon }: { here?: string | null; center?: string | null; icon?: React.ReactNode }): JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const { mode, setMode } = useTheme()
  const next = nextThemeMode(mode)

  useEffect(() => {
    let alive = true
    void window.airship.window.isMaximized().then((v) => alive && setMaximized(v))

    const off = window.airship.on((event) => {
      if (event.kind === 'window:maximized' && alive) setMaximized(event.value)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        {icon ?? (
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="0" y="0" width="16" height="16" rx="4.2" fill="#e2e1f1" />
            <rect x="3.4" y="3" width="4.6" height="4.6" rx="1.3" fill="#f86e51" />
            <rect x="8.9" y="3" width="4.6" height="4.6" rx="1.3" fill="#80b6a8" />
            <circle cx="5.7" cy="10.6" r="2.3" fill="#98a5e9" />
            <rect x="8.9" y="8.3" width="4.6" height="4.6" rx="2" fill="#eba6b8" />
          </svg>
        )}
        {/* 应用窗口只念应用名：这扇窗就是那个应用，"飞船 / "前缀是多余的自我说明 */}
        <span>{here ?? '飞船'}</span>
      </div>

      <div className="titlebar__center">{center ?? ''}</div>

      <div className="titlebar__controls">
        <button
          type="button"
          className="titlebar__btn"
          onClick={() => setMode(next)}
          aria-label={`主题：${THEME_LABEL[mode]}，点一下换成${THEME_LABEL[next]}`}
          title={`主题：${THEME_LABEL[mode]}（点一下换成${THEME_LABEL[next]}）`}
        >
          <ThemeGlyph mode={mode} />
        </button>

        <button
          type="button"
          className="titlebar__btn"
          onClick={() => void window.airship.window.minimize()}
          aria-label="最小化"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>

        <button
          type="button"
          className="titlebar__btn"
          onClick={() => void window.airship.window.toggleMaximize()}
          aria-label={maximized ? '还原' : '最大化'}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            {maximized ? (
              <>
                <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
                <path d="M2.5 2.5v-2h7v7h-2" fill="none" stroke="currentColor" />
              </>
            ) : (
              <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
            )}
          </svg>
        </button>

        <button
          type="button"
          className="titlebar__btn titlebar__btn--close"
          onClick={() => void window.airship.window.close()}
          aria-label="关闭"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </header>
  )
}

/** 三档各一个记号：月牙 / 太阳 / 半实半空的圆（原样搬自启动器那颗键） */
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
