import { useEffect, useState, type JSX } from 'react'

/**
 * 自绘标题栏。窗口是 frame:false，所以最小化/最大化/关闭得自己画。
 * 整条是可拖拽区（CSS 里的 -webkit-app-region: drag），按钮那一块显式排除。
 */
export function Titlebar({ here, center, icon }: { here?: string | null; center?: string | null; icon?: React.ReactNode }): JSX.Element {
  const [maximized, setMaximized] = useState(false)

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
