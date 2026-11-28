import { IconButton } from '@airship/sdk'
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { jobEvent, loadImages, nextJobId, pullArgs, rmiArgs, type WslcChunk, type WslcExit, type WslcRunner } from './cli'
import { cleanWslcError, errorMessage, isRemovalConflict, pullIsUpToDate, type RawImage } from './parse'
import {
  NEVER_REFRESHED,
  clockOfDay,
  elapsedText,
  imageContainerCount,
  imageDisplayName,
  imageInUse,
  imageMatches,
  imageReference,
  imageSizeText,
  imageSubtleLine,
  imageUsageText,
  imagesSummary,
  sortImages
} from './model'
import { useShellEvents } from './hooks'

/**
 * 镜像页：一列镜像 + 两个动作（拉取、删除）。
 *
 * 这一页**不做自动轮询**：镜像不像容器那样起起停停，待着不动就一条命令都不发。
 * 删除只在"常规删除被引擎以正被使用拒绝"之后才升级出强制删除——
 * 那是真把镜像从磁盘上拿走、留下的容器再也起不来，平时不给。
 *
 * 拉取开一张卡片：这台机器上的 wslc 不中途吐输出（管道、文件、伪终端三条路实测都一样），
 * 所以进行中唯一真的在走的是已等时长，输出的行到达后原样摆在卡片里。
 */

const EMPTY_SEARCH = '没有匹配的镜像'
const EMPTY_REFERENCE = '请先输入要拉取的镜像引用，例如 docker.1ms.run/library/redis:7。'
const FORCE_HINT = ' 该镜像正被容器使用，再点一次「强制删除」才能把它从磁盘上移除。'
const FOOTER_NOTE = '· 镜像不会自动变化，拉取或删除后会自动更新列表'
const PULL_PLACEHOLDER = '镜像引用，例如 docker.1ms.run/library/redis:7'
const NO_OUTPUT_YET = '这台机器上的 wslc 要跑完才报详细输出。'

type JobKind = 'pull' | 'rmi'
type CardState = 'running' | 'done' | 'failed' | 'cancelled'

const CARD_STATE_LABEL: Record<Exclude<CardState, 'running'>, string> = {
  done: '已结束',
  failed: '失败',
  cancelled: '已取消'
}

interface Pending {
  jobId: string
  kind: JobKind
  reference: string
  forced: boolean
}

interface PullCard {
  jobId: string
  reference: string
  command: string
  startedAt: number
  seconds: number
  lines: string[]
  state: CardState
  outcome: string
}

export function ImagesView({ runner }: { runner: WslcRunner }): JSX.Element {
  const api = runner.api

  const [all, setAll] = useState<RawImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [pullText, setPullText] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  /** 已经升级到"强制删除"的那些引用：这是用户刚做出来的决定，不该被一次刷新抹平 */
  const [forceFor, setForceFor] = useState<Record<string, boolean>>({})
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)
  const [card, setCard] = useState<PullCard | null>(null)

  const busy = useRef(false)
  const refreshing = useRef(false)
  const job = useRef<Pending | null>(null)
  const cancelled = useRef(false)
  /** chunk 的尾巴常常是半行，先留着，等下一块拼完再上屏 */
  const partial = useRef('')

  const refresh = useCallback(
    async (clearNotice = false): Promise<void> => {
      if (refreshing.current || busy.current) return
      refreshing.current = true
      try {
        const loaded = sortImages(await loadImages(runner))
        const alive = new Set(loaded.filter(imageInUse).map(imageReference))
        setAll(loaded)
        setForceFor((prev) => {
          const kept: Record<string, boolean> = {}
          for (const [reference, on] of Object.entries(prev)) if (on && alive.has(reference)) kept[reference] = true
          return kept
        })
        setError(null)
        if (clearNotice) setNotice(null)
        setLastRefresh(Date.now())
      } catch (err) {
        // 读失败不冲掉已经看见的列表
        setError(errorMessage(err))
      } finally {
        refreshing.current = false
      }
    },
    [runner]
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  const jobId = card?.jobId
  const running = card?.state === 'running'
  useEffect(() => {
    if (!running || !jobId) return
    const timer = setInterval(() => {
      setCard((prev) =>
        prev && prev.jobId === jobId && prev.state === 'running'
          ? { ...prev, seconds: Math.floor((Date.now() - prev.startedAt) / 1000) }
          : prev
      )
    }, 1000)
    return () => clearInterval(timer)
  }, [running, jobId])

  /** 卡片收尾：把状态、最后一拍的时长与结果那句一起落定（卡片不自己关） */
  const closeCard = (ofJob: string, state: CardState, outcome: string): void => {
    setCard((prev) =>
      prev && prev.jobId === ofJob
        ? { ...prev, state, outcome, seconds: Math.floor((Date.now() - prev.startedAt) / 1000) }
        : prev
    )
  }

  const begin = (kind: JobKind, args: string[], reference: string, forced: boolean): void => {
    const id = nextJobId(kind)
    const current: Pending = { jobId: id, kind, reference, forced }
    job.current = current
    busy.current = true
    cancelled.current = false
    partial.current = ''
    setPending(current)
    if (kind === 'pull') {
      setCard({
        jobId: id,
        reference,
        command: `wslc ${args.join(' ')}`,
        startedAt: Date.now(),
        seconds: 0,
        lines: [],
        state: 'running',
        outcome: ''
      })
    }
    // 开始新动作就清掉旧提示，免得新旧同屏让人误读
    setError(null)
    setNotice(null)

    void runner.start(id, args).catch((err: unknown) => {
      job.current = null
      busy.current = false
      setPending(null)
      const message = errorMessage(err)
      setError(message)
      if (kind === 'pull') closeCard(id, 'failed', message)
    })
  }

  const pull = (): void => {
    if (busy.current) return
    const reference = pullText.trim()
    if (reference.length === 0) {
      // 空引用绝不启动进程，只给一句人话
      setNotice(null)
      setError(EMPTY_REFERENCE)
      return
    }
    try {
      begin('pull', pullArgs(reference), reference, false)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const remove = (image: RawImage): void => {
    if (busy.current) return
    const reference = imageReference(image)
    const force = forceFor[reference] === true
    if (!window.confirm(confirmText(image, force))) return
    try {
      begin('rmi', rmiArgs(reference, force), reference, force)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const cancelPull = (): void => {
    const current = job.current
    if (!current || current.kind !== 'pull') return
    cancelled.current = true
    void runner.kill(current.jobId).catch(() => undefined)
  }

  useShellEvents(api, (event) => {
    const chunk = jobEvent<WslcChunk>(event, 'job:chunk')
    if (chunk) {
      const current = job.current
      if (current?.kind !== 'pull' || chunk.jobId !== current.jobId) return
      const pieces = (partial.current + chunk.text).split('\n')
      partial.current = pieces.pop() ?? ''
      const fresh = pieces.map((line) => line.replace(/\r$/, '')).filter((line) => line.length > 0)
      if (fresh.length === 0) return
      setCard((prev) => (prev && prev.jobId === chunk.jobId ? { ...prev, lines: [...prev.lines, ...fresh] } : prev))
      return
    }

    const exit = jobEvent<WslcExit>(event, 'job:exit')
    if (!exit) return
    const current = job.current
    if (!current || exit.jobId !== current.jobId) return

    job.current = null
    busy.current = false
    setPending(null)
    const result = exit

    if (current.kind === 'pull') {
      if (cancelled.current) {
        // 实测半途终止不会留下半截镜像：取消之后不必刷新，只需要把"已取消"说清楚
        cancelled.current = false
        const line = `已取消拉取 ${current.reference}`
        setNotice(line)
        closeCard(current.jobId, 'cancelled', line)
        return
      }
      if (result.code === 0) {
        const line = pullIsUpToDate(result.stdout)
          ? `${current.reference} 已是最新`
          : `已拉取 ${current.reference}`
        setNotice(line)
        closeCard(current.jobId, 'done', line)
        void refresh()
        return
      }
      const message = cleanWslcError(result.stderr)
      setError(message)
      closeCard(current.jobId, 'failed', message)
      return
    }

    if (result.code === 0) {
      setNotice(`已删除 ${current.reference}`)
      setForceFor((prev) => ({ ...prev, [current.reference]: false }))
      void refresh()
      return
    }

    const message = cleanWslcError(result.stderr)
    // 只有"正被容器使用"这一类失败才升级出强制删除；别的失败绝不给这个破坏性选项
    const conflict = current.kind === 'rmi' && !current.forced && isRemovalConflict(`${result.stderr}\n${result.stdout}`)
    if (conflict) {
      setForceFor((prev) => ({ ...prev, [current.reference]: true }))
      setError(`${message}${FORCE_HINT}`)
    } else {
      setError(message)
    }
  })

  const visible = all.filter((image) => imageMatches(image, search))
  const pulling = pending?.kind === 'pull' ? pending : null

  return (
    <div className="wsld__page">
      <div className="wsld__toolbar row">
        <input
          className="input wsld__search"
          placeholder="搜索仓库名 / 标签 / ID"
          aria-label="搜索仓库名 / 标签 / ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="spacer" />
        <span className="hint">{imagesSummary(all)}</span>
        <span className="hint wsld__refreshed">
          最近刷新 {lastRefresh === null ? NEVER_REFRESHED : clockOfDay(lastRefresh)}
        </span>
        <IconButton
          icon="refresh"
          label="刷新镜像列表（wslc images --format json）"
          testId="镜像-刷新"
          disabled={pending !== null}
          onClick={() => void refresh(true)}
        />
      </div>

      <div className="wsld__pull row">
        <span className="wsld__field">拉取</span>
        <input
          data-test="镜像-拉取框"
          aria-label="镜像引用"
          className="input wsld__pull-input"
          placeholder={PULL_PLACEHOLDER}
          value={pullText}
          disabled={pulling !== null}
          onChange={(e) => setPullText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') pull()
          }}
        />
        {pulling === null ? (
          <button type="button" className="btn btn--primary" data-test="镜像-拉取" disabled={pending !== null || pullText.trim().length === 0} onClick={pull}>
            拉取
          </button>
        ) : (
          <button type="button" className="btn" data-test="镜像-取消" onClick={cancelPull}>
            取消
          </button>
        )}
        {pulling !== null && (
          <span className="hint">
            正在拉取 {pulling.reference}
            <span className="spinner" />
          </span>
        )}
      </div>

      {error !== null && <div className="wsld__bar wsld__bar--error error">{error}</div>}
      {notice !== null && <div className="wsld__bar wsld__bar--ok">{notice}</div>}

      <div className="wsld__images">
        {visible.map((image) => {
          const reference = imageReference(image)
          const force = forceFor[reference] === true
          const here = pending?.kind === 'rmi' && pending.reference === reference
          return (
            <div className="wsld__image" key={reference}>
              <div className="wsld__image-main row">
                <span className="wsld__image-name">{imageDisplayName(image)}</span>
                <span className="wsld__image-size mono">{imageSizeText(image)}</span>
                <span className="wsld__image-usage hint">{imageUsageText(image)}</span>
                <span className="spacer" />
                {here && <span className="spinner" />}
                <IconButton
                  icon="remove"
                  label={force ? '强制删除镜像引用（wslc rmi -f）' : '删除镜像引用（wslc rmi）'}
                  testId={`镜像-删除-${reference}`}
                  danger={force}
                  disabled={pending !== null}
                  onClick={() => remove(image)}
                />
              </div>
              <div className="wsld__image-sub hint mono">{imageSubtleLine(image)}</div>
            </div>
          )
        })}
        {visible.length === 0 && all.length > 0 && <div className="hint wsld__empty">{EMPTY_SEARCH}</div>}
      </div>

      <div className="wsld__footer hint">{FOOTER_NOTE}</div>

      {card !== null && (
        <div className="wsld__modal">
          {/* 点外面那层不收：这一轮的时长与输出正看着，误点不该把它抹掉 */}
          <div className="wsld__modal-backdrop" />
          <section
            className="wsld__modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="拉取进度"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setCard(null)
            }}
          >
            <header className="wsld__card-head row">
              <span className="wsld__card-title">拉取 {card.reference}</span>
              <span className="spacer" />
              {card.state === 'running' && (
                <button type="button" className="btn" data-test="镜像-卡片-取消" onClick={cancelPull}>
                  取消
                </button>
              )}
              <button type="button" className="btn" data-test="镜像-卡片-关闭" onClick={() => setCard(null)}>
                关闭
              </button>
            </header>
            <p className="wsld__card-line mono" data-test="镜像-卡片-命令行">
              {card.command}
            </p>
            <p className="wsld__card-line" data-test="镜像-卡片-状态">
              {card.state === 'running'
                ? `进行中 · 已等 ${elapsedText(card.seconds)}`
                : `${CARD_STATE_LABEL[card.state]} · 已用 ${elapsedText(card.seconds)}`}
            </p>
            {card.outcome !== '' && <p className="wsld__card-line">{card.outcome}</p>}
            <div className="wsld__card-log mono" data-test="镜像-卡片-输出">
              {card.lines.length === 0 ? (
                <p className="hint">{NO_OUTPUT_YET}</p>
              ) : (
                card.lines.map((line, index) => <p key={index}>{line}</p>)
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

/** 删除前先问一句：没被占用的说清只取消标签，被占用的把话讲完再按 */
function confirmText(image: RawImage, force: boolean): string {
  const reference = imageReference(image)
  const count = imageContainerCount(image)
  if (force) return `强制删除镜像：该镜像正被 ${count} 个容器引用，强制删除后这些容器将无法再次启动。`
  const lines = [`确定要删除镜像引用 ${reference}？`]
  if (count > 0) lines.push(`该镜像正被 ${count} 个容器引用，这样删除会被拒绝，届时可再选择强制删除。`)
  lines.push('如果这个镜像还有其它标签，这一步只会取消当前标签。')
  return lines.join('\n')
}
