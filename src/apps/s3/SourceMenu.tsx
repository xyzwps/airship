import { useEffect, useRef, type JSX } from 'react'
import { hostOf, type Source } from './connection.ts'

/**
 * 顶栏那颗源键：合上时念当前用的哪一个源，点开是一列源，最后一行是「添加源」。
 *
 * 一行里念得出名字与主机——竖着排才放得下两样，横排成一排键就得把主机收进悬停说明，
 * 而那正是"看着连上其实连的是另一家"最容易看漏的那一样。
 * 当前那一个带底色；点一行就换端点。删除不在这里，走「连接设置」。
 *
 * 一个源都没有时，键上念「还没连上任何端点」，点开只有「添加源」。
 */
export function SourceMenu({
  sources,
  currentName,
  open,
  onToggle,
  onPick,
  onAdd
}: {
  sources: Source[]
  currentName: string
  open: boolean
  onToggle: () => void
  onPick: (name: string) => void
  onAdd: () => void
}): JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)

  // 点这一颗键与它那张面板之外的任何地方，面板就收起来
  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) onToggle()
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, onToggle])

  return (
    <div className="s3__menu" ref={root}>
      <button type="button" className="s3__menu-btn" data-test="sources-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="s3__menu-current">{currentName === '' ? '还没连上任何端点' : currentName}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M2.4 4 5 6.6 7.6 4" />
        </svg>
      </button>

      {open ? (
        <div className="s3__menu-panel">
          {sources.map((s) => (
            <button
              key={s.name}
              type="button"
              className={`s3__menu-row${s.name === currentName ? ' s3__menu-row--on' : ''}`}
              data-test={`pick:${s.name}`}
              onClick={() => onPick(s.name)}
            >
              <span className="s3__menu-label">{s.name}</span>
              <span className="s3__menu-host">{hostOf(s.endpoint)}</span>
            </button>
          ))}
          <button type="button" className="s3__menu-row s3__menu-add" data-test="sources-add" onClick={onAdd}>
            添加源
          </button>
        </div>
      ) : null}
    </div>
  )
}
