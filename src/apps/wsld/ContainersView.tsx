import { IconButton } from '@airship/sdk'
import { Fragment, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  containerActionArgs,
  loadContainers,
  nextJobId,
  type ContainerActionName,
  type WslcRunner
} from './cli'
import { cleanWslcError, errorMessage, parseLabels, type RawContainer } from './parse'
import {
  DASH,
  NEVER_REFRESHED,
  clockOfDay,
  containerLabel,
  containerMatches,
  containerSections,
  containersSummary,
  dash,
  isRunning,
  sortContainers,
  stateLabel
} from './model'
import { LogsView } from './LogsView'
import { useShellEvents } from './hooks'

/**
 * 容器页：左边一列容器，右边选中那个的详情与日志。
 *
 * 一行只报识别信息（名称、状态、镜像），其余字段全在详情里；
 * 页上同一时刻只让一个动作在飞，动作进行中不读列表。
 */

const EMPTY_MACHINE = '本机还没有容器'
const EMPTY_SEARCH = '没有匹配的容器'
const NO_SELECTION = '点击左侧的容器查看详情'
const GONE_CONTAINER = '未找到该容器，可能已被删除。'

export interface PendingAction {
  jobId: string
  id: string
  action: ContainerActionName
}

export function ContainersView({ runner }: { runner: WslcRunner }): JSX.Element {
  const api = runner.api

  const [all, setAll] = useState<RawContainer[]>([])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pane, setPane] = useState<'detail' | 'logs'>('detail')
  const [pending, setPending] = useState<PendingAction | null>(null)
  const [lastRefresh, setLastRefresh] = useState<number | null>(null)

  /** 全局一把闩：有动作在飞时按钮一律按不动、列表也不读 */
  const busy = useRef(false)
  const refreshing = useRef(false)
  const job = useRef<PendingAction | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    if (refreshing.current || busy.current) return
    refreshing.current = true
    try {
      const loaded = sortContainers(await loadContainers(runner))
      setAll(loaded)
      setError(null)
      setLastRefresh(Date.now())
    } catch (err) {
      // 读失败不冲掉已经看见的列表，只把清洗过的话说出来
      setError(errorMessage(err))
    } finally {
      refreshing.current = false
    }
  }, [runner])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const runAction = async (action: ContainerActionName, container: RawContainer): Promise<void> => {
    if (busy.current) return // 二次触发直接被吞掉，不排队、不叠加

    const force = action === 'remove' && isRunning(container.state)
    let args: string[]
    try {
      // ID 拿不到就一步都不迈：连进程都不起
      args = containerActionArgs(action, container.id, force)
    } catch (err) {
      setError(errorMessage(err))
      return
    }

    if (action !== 'start' && !window.confirm(confirmText(action, container, force))) return

    const jobId = nextJobId('act')
    const current: PendingAction = { jobId, id: container.id, action }
    job.current = current
    busy.current = true
    setPending(current)

    try {
      await runner.start(jobId, args)
    } catch (err) {
      job.current = null
      busy.current = false
      setPending(null)
      setError(errorMessage(err))
    }
  }

  useShellEvents(api, (event) => {
    if (event.kind !== 'proc:exit') return
    const current = job.current
    if (!current || event.jobId !== current.jobId) return

    job.current = null
    busy.current = false
    setPending(null)

    if (event.result.code === 0) {
      // 成功就补刷一次；删除成功的这个容器已经不在了，详情收回引导语
      if (current.action === 'remove' && selectedId === current.id) setSelectedId(null)
      void refresh()
    } else {
      // 失败就原地站着：不补刷，旧数据留着
      setError(cleanWslcError(event.result.stderr))
    }
  })

  const visible = all.filter((c) => containerMatches(c, search))
  const selected = selectedId === null ? null : all.find((c) => c.id === selectedId) ?? null
  const detailOf = selected ?? null

  return (
    <div className="wsld__page">
      <div className="wsld__toolbar row">
        <input
          className="input wsld__search"
          placeholder="搜索名称 / 镜像 / ID"
          aria-label="搜索名称 / 镜像 / ID"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="hint">{containersSummary(all)}</span>
        <span className="hint wsld__refreshed">
          最近刷新 {lastRefresh === null ? NEVER_REFRESHED : clockOfDay(lastRefresh)}
        </span>
        <IconButton
          icon="refresh"
          label="刷新容器列表（wslc list -a）"
          testId="容器-刷新"
          disabled={pending !== null}
          onClick={() => void refresh()}
        />
      </div>

      {error !== null && <div className="wsld__bar wsld__bar--error error">{error}</div>}

      <div className="wsld__split">
        <div className="wsld__list">
          {visible.map((container) => {
            const running = isRunning(container.state)
            const on = container.id === selectedId
            const rowBusy = pending?.id === container.id
            return (
              <div
                key={container.id}
                className={`wsld__row${on ? ' wsld__row--on' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(container.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') setSelectedId(container.id)
                }}
              >
                <span className={`wsld__dot${running ? ' wsld__dot--on' : ''}`} />
                <span className="wsld__row-name">{containerLabel(container)}</span>
                <span className={`wsld__row-state${running ? ' wsld__row-state--on' : ''}`}>
                  {stateLabel(container)}
                </span>
                <span className="wsld__row-image mono">{dash(container.image)}</span>
                {rowBusy && <span className="spinner" />}
                <IconButton
                  icon="start"
                  label="启动容器（wslc start）"
                  testId={`行-启动-${container.id}`}
                  className="wsld__row-action"
                  disabled={pending !== null || running}
                  onClick={(e) => {
                    e.stopPropagation()
                    void runAction('start', container)
                  }}
                />
              </div>
            )
          })}
          {visible.length === 0 && (
            <div className="hint wsld__empty">
              {all.length === 0 ? EMPTY_MACHINE : EMPTY_SEARCH}
            </div>
          )}
        </div>

        <div className="wsld__detail">
          {detailOf === null ? (
            <div className="placeholder">
              {selectedId === null ? NO_SELECTION : GONE_CONTAINER}
            </div>
          ) : (
            <>
              <div className="wsld__detail-head row">
                <span className="wsld__title">{containerLabel(detailOf)}</span>
                <span className={`wsld__badge${isRunning(detailOf.state) ? ' wsld__badge--on' : ''}`}>
                  {stateLabel(detailOf)}
                </span>
                <span className="spacer" />
                <IconButton
                  icon="start"
                  label="启动容器（wslc start）"
                  testId="详情-启动"
                  disabled={pending !== null || isRunning(detailOf.state)}
                  onClick={() => void runAction('start', detailOf)}
                />
                <IconButton
                  icon="stop"
                  label="停止容器（wslc stop）"
                  testId="详情-停止"
                  disabled={pending !== null || !isRunning(detailOf.state)}
                  onClick={() => void runAction('stop', detailOf)}
                />
                <IconButton
                  icon="restart"
                  label="重启容器（wslc restart）"
                  testId="详情-重启"
                  disabled={pending !== null}
                  onClick={() => void runAction('restart', detailOf)}
                />
                <IconButton
                  icon="remove"
                  label="删除容器（wslc remove）"
                  testId="详情-删除"
                  danger
                  disabled={pending !== null}
                  onClick={() => void runAction('remove', detailOf)}
                />
              </div>

              <div className="wsld__tabs row">
                <IconButton
                  icon="detail"
                  label="基本信息与运行状态"
                  testId="页签-详情"
                  on={pane === 'detail'}
                  onClick={() => setPane('detail')}
                />
                <IconButton
                  icon="logs"
                  label="容器日志"
                  testId="页签-日志"
                  on={pane === 'logs'}
                  onClick={() => setPane('logs')}
                />
              </div>

              <div className="wsld__pane" hidden={pane !== 'detail'}>
                {containerSections(detailOf).map((section) => (
                  <section className="card" key={section.title}>
                    <h4 className="card__title">{section.title}</h4>
                    <dl className="wsld__fields">
                      {section.fields.map((field) => (
                        <Fragment key={field.label}>
                          <dt>{field.label}</dt>
                          <dd className="mono">{field.value}</dd>
                        </Fragment>
                      ))}
                    </dl>
                  </section>
                ))}
                <section className="card">
                  <h4 className="card__title">标签</h4>
                  <Labels raw={detailOf.labels} />
                </section>
              </div>

              <div className="wsld__pane" hidden={pane !== 'logs'}>
                <LogsView
                  runner={runner}
                  containerRef={detailOf.id}
                  running={isRunning(detailOf.state)}
                  active={pane === 'logs'}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Labels({ raw }: { raw: string }): JSX.Element {
  const entries = parseLabels(raw)
  if (entries.length === 0) return <div className="mono wsld__label">{DASH}</div>
  return (
    <div className="wsld__labels">
      {entries.map((entry, index) => (
        <div className="wsld__label" key={`${entry.key}-${index}`}>
          {entry.key.length > 0 && <div className="wsld__label-key">{entry.key}</div>}
          <div className="wsld__label-value mono">{entry.value}</div>
        </div>
      ))}
    </div>
  )
}

/** 会打断容器里跑着的东西的动作，先问一句；措辞按按下这一刻的运行状态定 */
function confirmText(action: ContainerActionName, container: RawContainer, force: boolean): string {
  const name = containerLabel(container)
  if (action === 'stop') return `确定要停止容器 ${name}？容器里正在跑的进程会被终止（wslc stop）。`
  if (action === 'restart') return `确定要重启容器 ${name}？重启期间容器里的进程会中断（wslc restart）。`
  const body = `确定要删除容器 ${name}？此操作不可恢复。`
  return force ? `${body}\n该容器正在运行，将强制停止并删除（wslc remove -f）。` : body
}
