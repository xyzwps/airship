import { useEffect, useRef, useState, type JSX } from 'react'
import {
  DEFAULT_TAIL_LINES,
  TAIL_CHOICES,
  logsArgs,
  nextJobId,
  nowEpochSeconds,
  tailLabel,
  type WslcRunner
} from './cli'
import { cleanWslcError, errorMessage, prettyLine, prepareLogLines } from './parse'
import { clockOfDay } from './model'
import { useShellEvents } from './hooks'
import type { ProcResult } from '@shared/protocol'

/**
 * 容器详情的「日志」页签：两种读法各发各的命令，各有一份文本。
 *
 * 「查看日志」= 一次性读，可带尾部行数；
 * 「实时日志」= 从点下去这一刻起只收新行，**不倒历史**
 * （实测不带 `--since` 的 `logs -f` 会把全部历史先冲出来，那就不是实时）。
 */

/** 界面上最多留这么多行：实时挂着一夜不至于吃满内存，丢掉的行数在状态栏说得出 */
export const MAX_DISPLAYED_LINES = 2000

export const NOTICE_EMPTY_LOG = '这个容器目前没有任何输出。'
export const NOTICE_LIVE_STOPPED = '已停止实时日志。'
export const NOTICE_LIVE_ENDED = '实时日志已结束（容器多半已停止）。'
export const NOTICE_LIVE_ENDED_EMPTY = '实时日志已结束，期间没有新日志。'
export const LIVE_DISABLED_HINT = '容器没在运行，看不了实时日志；要翻旧日志请用「查看日志」。'
export const LIVE_ENABLED_HINT = '只收点下去之后的新行，不加载历史'

interface Props {
  runner: WslcRunner
  /** 当前看的是哪个容器：名称或 ID 都行 */
  containerRef: string
  running: boolean
  /** 页签是否正对着日志这一侧 */
  active: boolean
}

export function LogsView({ runner, containerRef, running, active }: Props): JSX.Element {
  const api = runner.api

  const [tail, setTail] = useState<number>(DEFAULT_TAIL_LINES)
  const [timestamps, setTimestamps] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)
  const [shown, setShown] = useState<string[]>([])
  const [dropped, setDropped] = useState(0)
  const [notice, setNotice] = useState('')
  const [loadedAt, setLoadedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [following, setFollowing] = useState(false)

  const box = useRef<HTMLPreElement | null>(null)
  /** 一次只挂一个日志进程：闩放在 ref 里，点击处理与事件回调看的是同一份 */
  const busyRef = useRef(false)
  const job = useRef<string | null>(null)
  const stoppedByUser = useRef(false)
  const received = useRef(0)
  /** chunk 的尾巴常常是半行，先留着，等下一块拼完再上屏 */
  const partial = useRef('')
  const stampOption = useRef(timestamps)
  const lines = useRef<string[]>([])
  const droppedCount = useRef(0)

  const paint = (): void => {
    setShown([...lines.current])
    setDropped(droppedCount.current)
    setLoadedAt(Date.now())
  }

  const wipeScreen = (): void => {
    lines.current = []
    droppedCount.current = 0
    setShown([])
    setDropped(0)
    setLoadedAt(null)
  }

  /** 追加行 + 裁到上限：丢掉的行数在状态栏说出口，不闷声吃屏 */
  const appendLines = (incoming: string[]): void => {
    if (incoming.length === 0) return
    lines.current = lines.current.concat(incoming)
    if (lines.current.length > MAX_DISPLAYED_LINES) {
      const excess = lines.current.length - MAX_DISPLAYED_LINES
      lines.current = lines.current.slice(excess)
      droppedCount.current += excess
    }
    paint()
  }

  /* ---------------- 两种读法 ---------------- */

  const readOnce = async (): Promise<void> => {
    if (busyRef.current) return
    let args: string[]
    try {
      args = logsArgs({ containerRef, tailLines: tail, timestamps, follow: false })
    } catch (err) {
      setNotice(errorMessage(err))
      return
    }

    busyRef.current = true
    setBusy(true)
    setNotice('')
    try {
      const result = await runner.run(args)
      if (result.code === 0) {
        const prepared = prepareLogLines(result.stdout, timestamps)
        wipeScreen()
        appendLines(prepared)
        // 已停止或从未启动的容器是"退出码 0 + 空输出"，这是正常，不是失败
        setNotice(prepared.length === 0 ? NOTICE_EMPTY_LOG : '')
      } else {
        // 读失败只进提示位，日志文本区保持失败前的样子
        setNotice(cleanWslcError(result.stderr))
      }
    } catch (err) {
      setNotice(errorMessage(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const startFollow = async (): Promise<void> => {
    if (busyRef.current || !running) return
    let args: string[]
    try {
      args = logsArgs({ containerRef, timestamps, follow: true, sinceEpochSeconds: nowEpochSeconds() })
    } catch (err) {
      setNotice(errorMessage(err))
      return
    }

    const jobId = nextJobId('logs')
    busyRef.current = true
    setBusy(true)
    setFollowing(true)
    stoppedByUser.current = false
    received.current = 0
    partial.current = ''
    stampOption.current = timestamps
    job.current = jobId
    // 新一轮实时从空白开始：上一趟读到的历史不该混进来
    wipeScreen()
    setNotice('')

    try {
      await runner.start(jobId, args)
    } catch (err) {
      job.current = null
      busyRef.current = false
      setBusy(false)
      setFollowing(false)
      setNotice(errorMessage(err))
    }
  }

  const stopFollow = async (): Promise<void> => {
    const jobId = job.current
    if (!jobId) return
    stoppedByUser.current = true
    const killed = await api.proc.kill(jobId).catch(() => false)
    // 进程刚好自己结束了：那句话由收尾那一路说，这里不抢
    if (!killed) stoppedByUser.current = false
  }

  /* ---------------- 事件回流 ---------------- */

  const onExit = (result: ProcResult): void => {
    job.current = null
    busyRef.current = false
    setBusy(false)
    setFollowing(false)

    const rest = partial.current.replace(/\r$/, '')
    partial.current = ''
    if (rest.length > 0) {
      received.current += 1
      appendLines([prettyLine(rest, stampOption.current)])
    }

    if (stoppedByUser.current) {
      stoppedByUser.current = false
      setNotice(NOTICE_LIVE_STOPPED)
      return
    }
    if (result.code !== 0) {
      setNotice(cleanWslcError(result.stderr))
      return
    }
    // 容器被停掉时 wslc 自己安静退场、不留一句"容器已结束"，这句得界面替它说
    setNotice(received.current === 0 ? NOTICE_LIVE_ENDED_EMPTY : NOTICE_LIVE_ENDED)
  }

  useShellEvents(api, (event) => {
    if (event.kind === 'proc:chunk') {
      if (event.jobId !== job.current || event.stream !== 'stdout') return
      partial.current += event.text
      const pieces = partial.current.split('\n')
      partial.current = pieces.pop() ?? ''
      const complete = pieces.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      if (complete.length > 0) {
        received.current += complete.length
        appendLines(complete.map((line) => prettyLine(line, stampOption.current)))
      }
      return
    }
    if (event.kind === 'proc:exit' && event.jobId === job.current) onExit(event.result)
  })

  /* ---------------- 会话收尾 ---------------- */

  // 换容器 = 旧会话立刻收摊：它的行、状态与丢弃计数都不该跟着用户跑到别的容器上
  useEffect(() => {
    if (job.current) {
      stoppedByUser.current = true
      void api.proc.kill(job.current).catch(() => undefined)
      job.current = null
    }
    busyRef.current = false
    partial.current = ''
    received.current = 0
    setBusy(false)
    setFollowing(false)
    wipeScreen()
    setNotice('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef, api])

  // 切走页签：只停实时，已显示的行留着，切回来还在原位
  useEffect(() => {
    if (!active) void stopFollow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 容器停下来了，这一趟实时就地收尾
  useEffect(() => {
    if (!running && job.current) void stopFollow()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  useEffect(() => {
    const el = box.current
    if (el && autoScroll) el.scrollTop = el.scrollHeight
  }, [shown, autoScroll])

  /* ---------------- 呈现 ---------------- */

  return (
    <div className="wsld__logs-pane">
      <div className="wsld__logbar row--wrap">
        <span className="wsld__field">行数</span>
        <select
          className="select"
          aria-label="行数"
          value={String(tail)}
          disabled={busy}
          onChange={(e) => setTail(Number(e.target.value))}
        >
          {TAIL_CHOICES.map((choice) => (
            <option key={choice} value={String(choice)}>
              {tailLabel(choice)}
            </option>
          ))}
        </select>

        <label className="wsld__check">
          <input
            type="checkbox"
            aria-label="显示时间戳"
            checked={timestamps}
            disabled={busy}
            onChange={(e) => setTimestamps(e.target.checked)}
          />
          <span>显示时间戳</span>
        </label>

        <label className="wsld__check">
          <input
            type="checkbox"
            aria-label="自动滚到底"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          <span>自动滚到底</span>
        </label>

        <button type="button" className="btn" data-test="日志-查看" disabled={busy} onClick={() => void readOnce()}>
          查看日志
        </button>
        <button
          type="button"
          className={`btn${following ? ' btn--primary' : ''}`}
          data-test="日志-实时"
          disabled={busy || !running}
          title={running ? LIVE_ENABLED_HINT : LIVE_DISABLED_HINT}
          onClick={() => void startFollow()}
        >
          实时日志
        </button>
        <button type="button" className="btn" data-test="日志-停止实时" disabled={!following} onClick={() => void stopFollow()}>
          停止实时
        </button>
        {busy && <span className="spinner" />}
      </div>

      <pre ref={box} className="wsld__logs mono selectable">{shown.join('\n')}</pre>

      <div className="wsld__logfoot">
        <span className="hint">
          {`共 ${shown.length} 行`}
          {loadedAt !== null && ` · 最近加载 ${clockOfDay(loadedAt)}`}
          {dropped > 0 && ` · 已丢弃最早的 ${dropped} 行`}
        </span>
        {notice.length > 0 && <span className="wsld__notice">{notice}</span>}
      </div>
    </div>
  )
}
