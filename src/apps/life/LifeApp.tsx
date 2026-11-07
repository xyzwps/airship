import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent, type ReactNode } from 'react'
import { useTheme } from '@airship/sdk'
import {
  GRID_LINE_MIN_PX,
  GRID_SIZES,
  MAJOR_EVERY,
  cellOfPoint,
  centeredAt,
  countAlive,
  emptyBoard,
  paintCell,
  randomBoard,
  stamp,
  step,
  type Board,
  type Edge
} from './life'
import { patternById, patternPlacement, patternsOf, GROUPS, type Pattern, type PatternGroup } from './patterns'
import './life.css'

/**
 * 生命游戏。
 *
 * 三件事，界面上就只围绕这三件：跑世代、放经典图形、自己涂格子。
 *
 * 世界只有**网格**：n×n 个格子，100 / 200 / 300 三档。没有"缩放档"这一族键——
 * 一格画几像素由可视区自己算（整张网格铺满短边，并在可视区里居中），
 * 玩家能调的只有"这张网多少格"和"这个窗口开多大"。
 * 网格范围永远有一圈标记；细格线只在格子够大时画，否则每十格一条刻度线兜底。
 */

const SPEEDS = [
  { label: '慢', ms: 400 },
  { label: '中', ms: 150 },
  { label: '快', ms: 50 }
] as const

/** 随机铺多少比例的格 */
const RANDOM_DENSITY = 0.3

/**
 * 开局网格上就有一只滑翔机停在那里（第 0 代，不自己跑）。
 * 空白网格第一次打开什么都看不见，学习者不知道该干什么；给一个会走的东西，
 * 点播放就看到它动，点两下涂也能立刻看到自己的东西加进去。
 */
function startBoard(n: number, edge: Edge): Board {
  const glider = patternById('glider')
  if (!glider) return emptyBoard(n, edge)
  const at = patternPlacement(glider, n)
  return stamp(emptyBoard(n, edge), glider, at.x, at.y)
}

export default function LifeApp(): JSX.Element {
  const { resolved } = useTheme()

  const [n, setN] = useState<number>(GRID_SIZES[0]!)
  const [edge, setEdge] = useState<Edge>('wrap')
  const [board, setBoard] = useState<Board>(() => startBoard(GRID_SIZES[0]!, 'wrap'))
  const [gen, setGen] = useState(0)
  const [running, setRunning] = useState(false)
  const [speedIdx, setSpeedIdx] = useState(1)
  /** 一格画几像素：不是玩家选的档，是可视区算出来的结果 */
  const [cellPx, setCellPx] = useState(6)
  /** 手风琴里当前展开的那一组；null = 全收起 */
  const [openGroup, setOpenGroup] = useState<PatternGroup | null>(GROUPS[0]!.id)
  const [notice, setNotice] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 这一笔是涂还是擦：按下时看到的那一格说了算，整笔沿用 */
  const paintRef = useRef<{ active: boolean; alive: boolean }>({ active: false, alive: true })
  /** 上一笔落点，用来把快速拖动漏掉的格子补上 */
  const lastCellRef = useRef<{ x: number; y: number } | null>(null)
  const noticeTimer = useRef<number | null>(null)
  const seed = useRef(1)

  const flash = useCallback((text: string) => {
    setNotice(text)
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2800)
  }, [])

  const live = countAlive(board)

  /* ---------- 一格多大：整张网格铺满可视区的短边，长边那一截由布局居中分掉 ---------- */

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const compute = () => {
      const side = Math.min(el.clientWidth, el.clientHeight)
      setCellPx(Math.max(1, Math.floor(side / n)))
    }
    compute()
    if (typeof ResizeObserver === 'undefined') return // jsdom 没有它：用例只断言文字与算式
    const observer = new ResizeObserver(compute)
    observer.observe(el)
    return () => observer.disconnect()
  }, [n])

  /* ---------- 画 ---------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const size = n * cellPx
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    // jsdom 没有 2D 上下文：界面用例只断言文字与档位，"真画出来了"归 just shot
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const style = getComputedStyle(document.documentElement)
    const readVar = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    const paper = readVar('--bg-elev', '#ffffff')
    const ink = readVar('--ok', '#4d7a5e')
    const minor = readVar('--border', 'rgba(0, 0, 0, 0.1)')
    const major = readVar('--border-strong', 'rgba(0, 0, 0, 0.18)')
    const frame = readVar('--accent', '#4a6fa5')

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = paper
    ctx.fillRect(0, 0, size, size)

    ctx.fillStyle = ink
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (board.cells[y * n + x] !== 1) continue
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx)
      }
    }

    // 细格线：格子太小就别画了，那时线比格子还粗
    if (cellPx >= GRID_LINE_MIN_PX) {
      ctx.strokeStyle = minor
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = 1; i < n; i++) {
        if (i % MAJOR_EVERY === 0) continue
        const p = Math.round(i * cellPx) + 0.5
        ctx.moveTo(0, p)
        ctx.lineTo(size, p)
        ctx.moveTo(p, 0)
        ctx.lineTo(p, size)
      }
      ctx.stroke()
    }

    // 刻度线：每十格一条，永远画得出——小档子上它是唯一能看出"这堆格子有多大"的东西
    const majorPx = cellPx * MAJOR_EVERY
    if (majorPx >= 3) {
      ctx.strokeStyle = major
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let i = MAJOR_EVERY; i < n; i += MAJOR_EVERY) {
        const p = Math.round(i * cellPx) + 0.5
        ctx.moveTo(0, p)
        ctx.lineTo(size, p)
        ctx.moveTo(p, 0)
        ctx.lineTo(p, size)
      }
      ctx.stroke()
    }

    // 网格范围的标记：一圈边框，任何缩放档都在
    ctx.strokeStyle = frame
    ctx.lineWidth = 2
    ctx.strokeRect(1, 1, size - 2, size - 2)
  }, [board, cellPx, n])

  useEffect(() => {
    draw()
  }, [draw, resolved])

  /* ---------- 跑世代 ---------- */

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      setBoard((prev) => step(prev))
      setGen((g) => g + 1)
    }, SPEEDS[speedIdx]!.ms)
    return () => window.clearInterval(timer)
  }, [running, speedIdx])

  // 全灭了就自己停下：让转着的键弹回来，界面上不留"看着在跑其实跑的是空网格"
  useEffect(() => {
    if (running && live === 0) {
      setRunning(false)
      flash('全灭了，停下来')
    }
  }, [running, live, flash])

  const stepOnce = useCallback(() => {
    setBoard((prev) => step(prev))
    setGen((g) => g + 1)
  }, [])

  /* ---------- 涂与擦 ---------- */

  const cellOf = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect()
      return cellOfPoint(e.clientX - rect.left, e.clientY - rect.top, cellPx, board)
    },
    [cellPx, board]
  )

  const paintAt = useCallback(
    (x: number, y: number, alive: boolean) => {
      setBoard((prev) => paintCell(prev, x, y, alive) ?? prev)
    },
    []
  )

  /**
   * 一笔之内要把经过的格子连起来涂。
   * 鼠标快拖时浏览器只给首尾两个点，中间那几格不补就会被跳过去——
   * 画出来的线断成几截，玩家看到的是"我明明拖过去了"。
   */
  const paintLine = useCallback(
    (from: { x: number; y: number } | null, to: { x: number; y: number }, alive: boolean) => {
      if (!from) {
        paintAt(to.x, to.y, alive)
        return
      }
      const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
        const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
        paintAt(x, y, alive)
      }
    },
    [paintAt]
  )

  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      if (e.button !== 0) return
      const hit = cellOf(e)
      if (!hit) return
      const want = board.cells[hit.y * n + hit.x] !== 1
      paintRef.current = { active: true, alive: want }
      lastCellRef.current = hit
      paintAt(hit.x, hit.y, want)
    },
    [cellOf, board, n, paintAt]
  )

  const onMouseMove = useCallback(
    (e: MouseEvent<HTMLCanvasElement>) => {
      if (!paintRef.current.active) return
      const hit = cellOf(e)
      if (!hit) return
      paintLine(lastCellRef.current, hit, paintRef.current.alive)
      lastCellRef.current = hit
    },
    [cellOf, paintLine]
  )

  useEffect(() => {
    const stop = () => {
      paintRef.current.active = false
      lastCellRef.current = null
    }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  /* ---------- 图形库、网格大小与画布操作 ---------- */

  const placePattern = useCallback(
    (pattern: Pattern) => {
      const at = patternPlacement(pattern, n)
      // 点图形 = 换一个起点：网格上从此只有它，世代从 0 重新数，跑着的也停下。
      // 不往现有格子上叠——两个图形都居中放就会互相咬住（放个方块再放滑翔机只剩 6 格），
      // 学习者看到的是"两个图形挤在一处乱成一团"，而不是图形本身的行为。
      // 要在别处加东西，用左键自己涂。
      setBoard(stamp(emptyBoard(n, edge), pattern, at.x, at.y))
      setGen(0)
      setRunning(false)
      flash(`换上「${pattern.name}」，从第 0 代开始`)
    },
    [flash, n, edge]
  )

  const changeGridSize = useCallback(
    (next: number) => {
      if (next === n) return
      setN(next)
      setBoard(startBoard(next, edge))
      setGen(0)
      setRunning(false)
      flash(`换成 ${next}×${next} 的网格，从第 0 代开始`)
    },
    [flash, n, edge]
  )

  const clearBoard = useCallback(() => {
    setBoard(emptyBoard(n, edge))
    setGen(0)
    setRunning(false)
    flash('网格清空了')
  }, [flash, n])

  const rollRandom = useCallback(() => {
    seed.current += 1
    setBoard(randomBoard(n, RANDOM_DENSITY, seed.current, edge))
    setGen(0)
    setRunning(false)
    flash('随机铺了一片，从第 0 代开始')
  }, [flash, n, edge])

  /** 换边界那一档不清盘、也不动世代：它改的是"下一步怎么数邻居"，不是现在画了什么 */
  const changeEdge = useCallback(
    (next: Edge) => {
      if (next === edge) return
      setEdge(next)
      setBoard((prev) => (prev.edge === next ? prev : { n: prev.n, edge: next, cells: prev.cells }))
    },
    [edge]
  )

  return (
    <div className="life">
      <div className="life__bar">
        <Key testId="play" label={running ? '暂停' : '播放'} on={running} onClick={() => setRunning((r) => !r)}>
          {running ? (
            <svg {...glyph}>
              <rect x="3.6" y="3.6" width="8.8" height="8.8" rx="1" {...strokeCfg} />
            </svg>
          ) : (
            <svg {...glyph}>
              <path d="M5.2 3.1v9.8L13 8Z" {...strokeCfg} />
            </svg>
          )}
        </Key>
        <Key testId="step" label="走一代" onClick={stepOnce}>
          <svg {...glyph}>
            <path d="M4.2 3.1v9.8L10.4 8Z" {...strokeCfg} />
            <path d="M12.6 3.2v9.6" {...strokeCfg} />
          </svg>
        </Key>
        <Key
          testId="random"
          label={`随机铺 ${Math.round(RANDOM_DENSITY * 100)}% 的格子，并从第 0 代开始`}
          onClick={rollRandom}
        >
          <svg {...glyph}>
            <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" {...strokeCfg} />
            <circle cx="6" cy="6" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="10" cy="10" r="0.9" fill="currentColor" stroke="none" />
            <circle cx="10" cy="6" r="0.9" fill="currentColor" stroke="none" />
          </svg>
        </Key>
        <Key testId="clear" label="清空网格" onClick={clearBoard}>
          <svg {...glyph}>
            <path d="M2.8 4.3h10.4M6.4 4.3V2.8h3.2v1.5" {...strokeCfg} />
            <path d="M4.2 4.3l.7 8.4h6.2l.7-8.4" {...strokeCfg} />
          </svg>
        </Key>

        <span className="life__sep" />
        <div className="life__segset" role="group" aria-label="网格大小">
          {GRID_SIZES.map((size) => (
            <button
              key={size}
              type="button"
              className={`life__seg${size === n ? ' life__seg--on' : ''}`}
              data-test={`grid-${size}`}
              title={`网格 ${size}×${size} 格（换档就重开一张网格）`}
              aria-pressed={size === n}
              onClick={() => changeGridSize(size)}
            >
              {size}×{size}
            </button>
          ))}
        </div>
        <div className="life__segset" role="group" aria-label="边界">
          <button
            type="button"
            className={`life__seg${edge === 'wrap' ? ' life__seg--on' : ''}`}
            data-test="edge-wrap"
            title="环绕：走到边上从对边继续，整张网格是个环面，滑翔机永远撞不碎"
            aria-pressed={edge === 'wrap'}
            onClick={() => changeEdge('wrap')}
          >
            环绕
          </button>
          <button
            type="button"
            className={`life__seg${edge === 'wall' ? ' life__seg--on' : ''}`}
            data-test="edge-wall"
            title="墙：边上就是尽头，贴边的结构会撞碎"
            aria-pressed={edge === 'wall'}
            onClick={() => changeEdge('wall')}
          >
            墙
          </button>
        </div>
        <div className="life__segset" role="group" aria-label="速度">
          {SPEEDS.map((s, i) => (
            <button
              key={s.label}
              type="button"
              className={`life__seg${i === speedIdx ? ' life__seg--on' : ''}`}
              data-test={`speed-${s.label}`}
              title={`速度 ${s.label}（每 ${s.ms} 毫秒一代）`}
              aria-pressed={i === speedIdx}
              onClick={() => setSpeedIdx(i)}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="life__stat mono" data-test="stat">
          第 {gen} 代 · 存活 {live} · 网格 {n}×{n} · 一格 {cellPx} 像素
        </div>
      </div>

      <div className="life__main">
        <div className="life__stage" ref={stageRef}>
          <canvas
            ref={canvasRef}
            className="life__canvas"
            data-test="canvas"
            aria-label={`生命游戏网格 ${n}×${n} 格，第 ${gen} 代存活 ${live} 格`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
          />
        </div>

        <aside className="life__lib">
          <div className="life__lib-title">经典图形</div>
          {/*
            手风琴：一次只展开一组。十五个图形全摊开时面板就是一堵字，
            要看的那几行反而被埋掉；收起的那组连节点都不留，界面上就是读不到它。
          */}
          {GROUPS.map((group) => {
            const items = patternsOf(group.id)
            const expanded = openGroup === group.id
            return (
              <section key={group.id} className="life__group">
                <button
                  type="button"
                  className="life__group-head"
                  data-test={`group-${group.id}`}
                  aria-expanded={expanded}
                  title={expanded ? `收起「${group.name}」` : `展开「${group.name}」（${items.length} 个）`}
                  onClick={() => setOpenGroup(expanded ? null : group.id)}
                >
                  <svg className={`life__chevron${expanded ? ' life__chevron--on' : ''}`} {...glyph}>
                    <path d="M6 3.6 10.6 8 6 12.4" {...strokeCfg} />
                  </svg>
                  <span className="life__group-name">{group.name}</span>
                  <span className="life__group-count mono">{items.length}</span>
                </button>
                {expanded &&
                  items.map((pattern) => (
                    <button
                      key={pattern.id}
                      type="button"
                      className="life__pattern"
                      data-test={`pattern-${pattern.id}`}
                      title={pattern.note}
                      onClick={() => placePattern(pattern)}
                    >
                      <span className="life__pattern-name">{pattern.name}</span>
                      <span className="life__pattern-note">{pattern.note}</span>
                    </button>
                  ))}
              </section>
            )
          })}
          <div className="life__hint hint">
            点一个图形，网格上就只剩它，从第 0 代重新数。
            <br />
            按住左键拖就能自己涂：按下去那一格是死的就一路涂活，是活的就一路擦。
            <br />
            换网格大小（100 / 200 / 300）会重开一张网格。
          </div>
        </aside>
      </div>

      {notice && (
        <div className="life__notice" data-test="notice">
          {notice}
        </div>
      )}
    </div>
  )
}

/* ---------- 图形键：界面上只画图形，所以悬停说明与无障碍名称是必填项 ---------- */

const glyph = { width: 17, height: 17, viewBox: '0 0 16 16', 'aria-hidden': true } as const
const strokeCfg = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
} as const

interface KeyProps {
  testId: string
  label: string
  on?: boolean
  children: ReactNode
  onClick: () => void
}

function Key({ testId, label, on, children, onClick }: KeyProps): JSX.Element {
  return (
    <button
      type="button"
      className={`icon-btn${on ? ' icon-btn--on' : ''}`}
      data-test={testId}
      title={label}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
