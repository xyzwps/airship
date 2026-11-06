import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from 'react'
import { HELP, type HelpKey } from './help'
import { HelpDemo } from './HelpDemos'

/**
 * 参数旁边那颗 ?：指针放上去念出「它干什么」与「代价是什么」。
 *
 * 这几条规矩是这一件的难点，都在代码里钉着：
 *   - 文件名是 HelpTip 而不是 Help：Windows 的大小写不敏感会把 `./Help` 解析到文案文件 `help.ts` 上
 *   - 卡片 `position: fixed`：面板自己会滚动，绝对定位会被 `overflow` 剪掉半张卡
 *   - 问号与卡片是同一块热区：指针从问号挪到卡片上不算离开（中间隔着 GAP 那点空，
 *     所以离开之后留一拍缓冲，另一侧接得上就不收）；卡片因此吃鼠标，里面的文字也选得中
 *   - 它是纯图标键，所以 `aria-label` 与 `role="tooltip"` 是强制项，键盘 Tab 上去也出
 */

const GAP = 8
const EDGE = 8
/** 问号与卡片之间隔着 GAP 那点空，指针挪过去要花时间：这一拍之内接得上就不收 */
const LEAVE_MS = 160

/**
 * 圈里一个问号。描边风格跟着壳的 IconButton 那批图形走（同宽、同圆头），
 * 这样它与「详情」那颗圈里带 i 的键在视觉上是同一家人。
 */
function QuestionGlyph(): JSX.Element {
  const box = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  const stroke = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  } as const
  return (
    <svg {...box}>
      <circle cx="8" cy="8" r="6.4" {...stroke} />
      <path d="M6.3 6.3a1.8 1.8 0 1 1 3.4.9c-.5.7-1.65 1.1-1.65 2.3" {...stroke} />
      <path d="M8.05 12.1v.1" {...stroke} strokeWidth={1.8} />
    </svg>
  )
}

/** 卡片摆在哪、翻没翻面、箭头离卡片左边多远 */
export interface Where {
  left: number
  top: number
  caretX: number
  side: 'below' | 'above'
}

/**
 * 摆位就这一处算术，输入全是数字，所以能单独拿数验证（VC-081）。
 * 竖着先往下；下面放不下就翻到上面，箭头跟着从卡片上边挪到下边。
 * 横着以问号为中心，被视口夹住时卡片会挪开，但箭头得自己找回问号那一列。
 */
export function placeCard(
  btn: { left: number; top: number; bottom: number; width: number },
  size: { w: number; h: number },
  view: { w: number; h: number }
): Where {
  const cx = btn.left + btn.width / 2
  const below = btn.bottom + GAP
  const flip = size.h > 0 && below + size.h > view.h - EDGE
  const left = Math.min(Math.max(cx - size.w / 2, EDGE), Math.max(EDGE, view.w - size.w - EDGE))
  // 14 是把尖从圆角上挪开的最小距离：贴边也要看得出那是支箭，不是卡片的一个角
  const caretX = Math.min(Math.max(cx - left, 14), Math.max(14, size.w - 14))
  return { left, top: flip ? Math.max(EDGE, btn.top - GAP - size.h) : below, caretX, side: flip ? 'above' : 'below' }
}

export function Help({ k }: { k: HelpKey }): JSX.Element {
  const entry = HELP[k]
  const btn = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Where | null>(null)

  const stop = (): void => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }

  /** 指针落到问号或卡片任意一侧：算"还在看"，把那一拍缓冲撤掉 */
  const stay = useCallback((): void => {
    stop()
    setOpen(true)
  }, [])

  /** 离开这一侧：先不收，等一拍——指针接住另一侧就留下，否则收 */
  const leaveSoon = useCallback((): void => {
    stop()
    timer.current = window.setTimeout(() => {
      timer.current = null
      setOpen(false)
    }, LEAVE_MS)
  }, [])

  /** 按按钮的位置摆卡片：横着居中、竖着先往下，下面放不下就翻到上面；箭头始终指着问号 */
  const place = useCallback((): void => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    // 按钮被滚出视口了，卡片贴在边上没有意义
    if (r.bottom < 0 || r.top > window.innerHeight) {
      setOpen(false)
      return
    }
    const w = card.current?.offsetWidth ?? 320
    const h = card.current?.offsetHeight ?? 0
    setPos(
      placeCard(
        { left: r.left, top: r.top, bottom: r.bottom, width: r.width },
        { w, h },
        { w: window.innerWidth, h: window.innerHeight }
      )
    )
  }, [])

  // 先按 0,0 渲染一帧拿高度，再在同一趟布局里挪到位——绘制之前完成，看不到跳
  useLayoutEffect(() => {
    if (open) place()
  }, [open, place])

  // 悬浮期间窗口 resized 或任何一层滚动，按钮会跑位：卡片跟着重摆，接不上（滚出视口）就收
  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open, place])

  // 卸载时把没跑完的那一拍清掉，别让它在已死的组件上 setState
  useEffect(() => stop, [])

  return (
    <>
      <button
        ref={btn}
        type="button"
        className="vcp__help"
        data-help={k}
        aria-label={`说明：${entry.title}`}
        aria-describedby={open ? `vcp-help-${k}` : undefined}
        onMouseEnter={stay}
        onMouseLeave={leaveSoon}
        onFocus={stay}
        onBlur={leaveSoon}
      >
        <QuestionGlyph />
      </button>
      {open && (
        <div
          ref={card}
          id={`vcp-help-${k}`}
          data-help={k}
          role="tooltip"
          className={`vcp__help-card selectable vcp__help-card--${pos?.side ?? 'below'}`}
          style={
            {
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              '--caret-x': `${pos?.caretX ?? 0}px`
            } as CSSProperties
          }
          onMouseEnter={stay}
          onMouseLeave={leaveSoon}
        >
          <div className="vcp__help-title">{entry.title}</div>
          <div className="vcp__help-line">
            <span className="vcp__help-tag">作用</span>
            <span>{entry.what}</span>
          </div>
          <div className="vcp__help-line">
            <span className="vcp__help-tag">代价</span>
            <span>{entry.cost}</span>
          </div>
          {entry.demo && <HelpDemo name={entry.demo} />}
        </div>
      )}
    </>
  )
}
