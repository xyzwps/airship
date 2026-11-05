import type { JSX } from 'react'
import type { AppMeta } from '@shared/registry'

/** 侧栏/卡片图标。用 manifest 里的 path 数据画，不引入图标库。 */
export function AppIcon({ meta, className }: { meta: AppMeta; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {meta.iconPath.split(' M').map((segment, i) => (
        <path key={i} d={i === 0 ? segment : `M${segment}`} />
      ))}
    </svg>
  )
}
