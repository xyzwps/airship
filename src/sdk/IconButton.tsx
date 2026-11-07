import { type JSX, type MouseEvent } from 'react'

/**
 * 图标键（壳的渲染侧件，应用直接用）：界面上只画图形，动作名字靠悬停说明与无障碍名称说话。
 *
 * 文字按钮会把行撑满（一列六行各挂一颗"启动"，行里就只剩按钮了），图标换回横向空间。
 * 代价是读屏与键盘用户看不见它是什么，所以 `title` 与 `aria-label` 是**强制项**，
 * 不是可选项——见 `src/apps/specs/app-model.md` 与 wsld 那几本册子里的同一条。
 */

export type IconName = 'back' | 'refresh' | 'start' | 'stop' | 'restart' | 'remove' | 'detail' | 'logs'

export function Glyph({ name }: { name: IconName }): JSX.Element {
  const box = { width: 17, height: 17, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
  switch (name) {
    case 'back':
      // 向左的箭头：回上一级
      return (
        <svg {...box}>
          <path d="M6.6 3.4 2.6 8l4 4.6M3 8h10.2" {...stroke} />
        </svg>
      )
    case 'start':
      // 播放三角
      return (
        <svg {...box}>
          <path d="M5.2 3.1v9.8L13 8Z" {...stroke} />
        </svg>
      )
    case 'stop':
      return (
        <svg {...box}>
          <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1" {...stroke} />
        </svg>
      )
    case 'restart':
      // 一圈带回箭头的弧，顶上那道竖杠把它与"刷新"分开
      return (
        <svg {...box}>
          <path d="M13 8a5 5 0 1 1-1.5-3.6" {...stroke} />
          <path d="M12.9 1.9v2.9h-2.9" {...stroke} />
          <path d="M8 1.6v1.6" {...stroke} />
        </svg>
      )
    case 'remove':
      // 垃圾桶
      return (
        <svg {...box}>
          <path d="M2.8 4.3h10.4M6.4 4.3V2.8h3.2v1.5" {...stroke} />
          <path d="M4.2 4.3l.7 8.4h6.2l.7-8.4" {...stroke} />
          <path d="M6.8 6.6v4M9.2 6.6v4" {...stroke} />
        </svg>
      )
    case 'detail':
      // 圈里一个 i
      return (
        <svg {...box}>
          <circle cx="8" cy="8" r="6.2" {...stroke} />
          <path d="M8 7.1v4" {...stroke} />
          <path d="M8 4.6v.1" {...stroke} strokeWidth={1.7} />
        </svg>
      )
    case 'logs':
      // 三行文字
      return (
        <svg {...box}>
          <path d="M3 4.2h10M3 8h10M3 11.8h7" {...stroke} />
        </svg>
      )
    default:
      // 刷新：两段弧各带一个箭头
      return (
        <svg {...box}>
          <path d="M13.2 6.2A5.4 5.4 0 0 0 3.4 5.1" {...stroke} />
          <path d="M2.8 9.8a5.4 5.4 0 0 0 9.8 1.1" {...stroke} />
          <path d="M3.5 2.4v2.8H6.3M12.5 13.6v-2.8h-2.8" {...stroke} />
        </svg>
      )
  }
}

export interface IconButtonProps {
  icon: IconName
  /** 悬停说明与无障碍名称都读它：说清这颗键干什么，必要时带上命令行 */
  label: string
  /** 用例找键用的名字（沿用 data-test，图标化之后它比可见文字更稳） */
  testId: string
  danger?: boolean
  disabled?: boolean
  /** 页签那种"选中态要画出来"的用法 */
  on?: boolean
  /** 位置相关的修饰（比如行尾那颗不许被压缩） */
  className?: string
  onClick: (e: MouseEvent<HTMLButtonElement>) => void
}

export function IconButton({ icon, label, testId, danger, disabled, on, className, onClick }: IconButtonProps): JSX.Element {
  const cls = ['icon-btn', className ?? '', danger ? 'icon-btn--danger' : '', on ? 'icon-btn--on' : ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      data-test={testId}
      title={label}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      disabled={disabled}
      onClick={onClick}
    >
      <Glyph name={icon} />
    </button>
  )
}
