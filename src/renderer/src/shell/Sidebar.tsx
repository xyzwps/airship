import type { JSX } from 'react'
import { APPS } from '@shared/registry'
import type { AppId } from '@shared/protocol'
import { AppIcon } from './AppIcon'

interface Props {
  active: AppId | null
  onPick: (id: AppId | null) => void
  footer: React.ReactNode
}

export function Sidebar({ active, onPick, footer }: Props): JSX.Element {
  return (
    <nav className="sidebar">
      <button
        type="button"
        className="navitem"
        data-active={active === null}
        onClick={() => onPick(null)}
      >
        <svg
          className="navitem__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 11h7v7H4z M13 6h7v7h-7z" />
        </svg>
        <span className="navitem__name">总览</span>
      </button>

      <div className="sidebar__label">应用</div>

      {APPS.map((meta) => (
        <button
          key={meta.id}
          type="button"
          className="navitem"
          data-active={active === meta.id}
          style={{ ['--nav-accent' as string]: meta.accent }}
          onClick={() => onPick(meta.id)}
          title={meta.description}
        >
          <AppIcon meta={meta} className="navitem__icon" />
          <span className="navitem__name">{meta.name}</span>
        </button>
      ))}

      <div className="sidebar__foot">{footer}</div>
    </nav>
  )
}
