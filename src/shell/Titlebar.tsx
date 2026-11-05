import { useEffect, useState, type JSX } from 'react'

/**
 * 自绘标题栏。窗口是 frame:false，所以最小化/最大化/关闭得自己画。
 * 整条是可拖拽区（CSS 里的 -webkit-app-region: drag），按钮那一块显式排除。
 */
export function Titlebar({ here, icon }: { here?: string | null; icon?: React.ReactNode }): JSX.Element {
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
            <rect x="0.5" y="0.5" width="15" height="15" rx="4.5" fill="#2e3a54" />
            <path d="M2 14L14 2" stroke="#f0ece2" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="8" cy="5.6" r="1.5" fill="#f0ece2" />
          </svg>
        )}
        <span>飞船</span>
        {here && (
          <>
            <span style={{ color: 'var(--fg-faint)' }}>/</span>
            <span className="titlebar__here">{here}</span>
          </>
        )}
      </div>

      <div className="titlebar__spacer" />

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
