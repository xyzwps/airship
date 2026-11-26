import { useEffect, useRef, type JSX } from 'react'
import { Icon } from '@iconify/react'
import type { Source } from './connection.ts'
import './icons.ts'

/**
 * 顶栏那颗源键：合上时念当前用的哪一个源，点开是一列源，最后一行是「添加源」（前面一颗加号）。
 *
 * 一行只念名字——主机与端口杵在右边会把行撑宽，而认出一个源靠的就是他起的那个名字；
 * 键与那一列都钉成左栏那一列的宽度（观感归截图走查，不进册子）。
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
        <Icon icon="lucide:chevron-down" width="12" height="12" aria-hidden="true" />
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
            </button>
          ))}
          <button type="button" className="s3__menu-row s3__menu-add" data-test="sources-add" onClick={onAdd}>
            <Icon icon="lucide:plus" width="14" height="14" aria-hidden="true" />
            添加源
          </button>
        </div>
      ) : null}
    </div>
  )
}
