import { IconButton } from '@shell/IconButton'
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { loadImages, nextJobId, pullArgs, rmiArgs, type WslcRunner } from './cli'
import {
  cleanWslcError,
  errorMessage,
  isRemovalConflict,
  pullIsUpToDate,
  type RawImage
} from './parse'
import {
  NEVER_REFRESHED,
  clockOfDay,
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
 */

const EMPTY_SEARCH = '没有匹配的镜像'
const EMPTY_REFERENCE = '请先输入要拉取的镜像引用，例如 docker.1ms.run/library/redis:7。'
const FORCE_HINT = ' 该镜像正被容器使用，再点一次「强制删除」才能把它从磁盘上移除。'
const FOOTER_NOTE = '· 镜像不会自动变化，拉取或删除后会自动更新列表'
const PULL_PLACEHOLDER = '镜像引用，例如 docker.1ms.run/library/redis:7'

type JobKind = 'pull' | 'rmi'

interface Pending {
  jobId: string
  kind: JobKind
  reference: string
  forced: boolean
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

  const busy = useRef(false)
  const refreshing = useRef(false)
  const job = useRef<Pending | null>(null)
  const cancelled = useRef(false)

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

  const begin = (kind: JobKind, args: string[], reference: string, forced: boolean): void => {
    const jobId = nextJobId(kind)
    const current: Pending = { jobId, kind, reference, forced }
    job.current = current
    busy.current = true
    cancelled.current = false
    setPending(current)
    // 开始新动作就清掉旧提示，免得新旧同屏让人误读
    setError(null)
    setNotice(null)

    void runner.start(jobId, args).catch((err: unknown) => {
      job.current = null
      busy.current = false
      setPending(null)
      setError(errorMessage(err))
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
    void api.proc.kill(current.jobId).catch(() => undefined)
  }

  useShellEvents(api, (event) => {
    if (event.kind !== 'proc:exit') return
    const current = job.current
    if (!current || event.jobId !== current.jobId) return

    job.current = null
    busy.current = false
    setPending(null)
    const result = event.result

    if (current.kind === 'pull') {
      if (cancelled.current) {
        // 实测半途终止不会留下半截镜像：取消之后不必刷新，只需要把"已取消"说清楚
        cancelled.current = false
        setNotice(`已取消拉取 ${current.reference}`)
        return
      }
      if (result.code === 0) {
        setNotice(
          pullIsUpToDate(result.stdout)
            ? `${current.reference} 已是最新`
            : `已拉取 ${current.reference}`
        )
        void refresh()
        return
      }
      setError(cleanWslcError(result.stderr))
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
