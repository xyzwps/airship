import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type JSX } from 'react'
import type { AppApi } from '../../shell/useAppApi'
import { isShotMode } from '../../shell/shot'
import { build, checks, defaultOutPath, display, type Fix, type Note } from './command'
import {
  buildBatchSpec,
  detailText,
  forTarget,
  fromState,
  JobQueue,
  statusText,
  uniquePath,
  type JobSpec
} from './jobs'
import { parseProbe, subSnippet, decodeText } from './probe'
import { Runner } from './runner'
import {
  createState,
  human,
  isBitmapSub,
  isCover,
  mainVideo,
  subKey,
  subTitle,
  type AppState,
  type ProbeInfo,
  type StreamInfo,
  type SubRef
} from './state'
import './vcp.css'

/**
 * vcp —— FFmpeg 编排台，桌面版。
 *
 * 与 Avalonia 版的差别：
 *   - 界面从 XAML 换成 React，布局改成"左配置 / 右队列"两栏，宽屏下不用滚来滚去。
 *   - 进程管理交给壳的 proc 服务（白名单只放行壳发现的 ffmpeg），不再自己 Process.Start。
 *   - 临时字幕落在应用 cache 目录，不再用系统 %TEMP%，卸载/清缓存就干净了。
 *   - 文件浏览从自绘目录树换成系统对话框 + 父目录授权（grantParentDir），
 *     少一整棵树的代码，代价是不能在界面里翻目录——这点是退步，认。
 */
export default function VcpApp({ api }: { api: AppApi }): JSX.Element {
  const stateRef = useRef<AppState>(createState())
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const mut = useCallback(
    (fn: (s: AppState) => void) => {
      fn(stateRef.current)
      bump()
    },
    []
  )

  const queueRef = useRef<JobQueue | null>(null)
  if (!queueRef.current) queueRef.current = new JobQueue()
  const queue = queueRef.current

  const runnerRef = useRef<Runner | null>(null)
  if (!runnerRef.current) {
    runnerRef.current = new Runner({
      api,
      queue,
      onChange: () => bump(),
      onFinished: (j) => {
        for (const f of j.tempFiles) {
          void api.fs.remove(f).catch(() => undefined)
        }
        j.tempFiles = []
      }
    })
  }
  const runner = runnerRef.current

  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null)
  const [probing, setProbing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [outStat, setOutStat] = useState<{ size: number } | null>(null)
  const [subPreviews, setSubPreviews] = useState<Record<string, string>>({})
  const [copied, setCopied] = useState(false)
  const [cacheDir, setCacheDir] = useState<string>('')

  useEffect(() => {
    let alive = true
    void runner.init().then((exe) => alive && setFfmpegReady(exe !== null))
    void api.paths().then((p) => alive && setCacheDir(p.cache))
    runner.attach()
    return () => {
      alive = false
      runner.detach()
    }
  }, [api, runner])

  const s = stateRef.current

  /* ---------- 输出路径存在性（给 checks 用） ---------- */
  useEffect(() => {
    const path = s.out.path
    if (!path) {
      setOutStat(null)
      return
    }
    let alive = true
    api.fs
      .stat(path)
      .then((st) => alive && setOutStat(st && !st.isDirectory ? { size: st.size } : null))
      .catch(() => alive && setOutStat(null))
    return () => {
      alive = false
    }
  }, [api, s.out.path])

  const notes: Note[] = useMemo(() => checks(s, outStat), [s, outStat, bump])

  /* ---------- 探测 ---------- */

  const probeFile = useCallback(
    async (path: string): Promise<ProbeInfo> => {
      const exe = await runner.init()
      if (!exe) throw new Error('没找到 ffmpeg')
      const stat = await api.fs.stat(path)
      if (!stat) throw new Error(`读不到文件：${path}`)
      const res = await api.proc.run({ exe, args: ['-hide_banner', '-i', path] })
      const name = path.split(/[\\/]/).pop() ?? path
      const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
      const dir = slash >= 0 ? path.slice(0, slash) : ''
      return parseProbe(res.stderr, { path, name, dir, size: stat.size })
    },
    [api, runner]
  )

  const autoSelect = (probe: ProbeInfo): void => {
    mut((st) => {
      st.probe = probe
      st.extSubs = []
      st.extracted = {}
      const video = probe.streams.find((x) => x.type === 'video' && !isCover(x))
      st.keep.videoRel = video?.rel ?? null
      const audios = probe.streams.filter((x) => x.type === 'audio')
      const defAudio = audios.find((x) => x.isDefault) ?? audios[0]
      st.keep.audioRels = defAudio ? [defAudio.rel] : []
      st.keep.subs = []
      st.out.pathTouched = false
      defaultOutPath(st)
    })
  }

  const openVideo = async (): Promise<void> => {
    setProbing(true)
    setError(null)
    try {
      const picked = await api.dialog.openFiles({
        title: '选择视频',
        grantParentDir: true,
        filters: [
          {
            name: '媒体',
            extensions: [
              'mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts', 'flv', 'wmv', 'mpg', 'mpeg', 'm4v', 'mts',
              'mp3', 'm4a', 'aac', 'flac', 'wav', 'opus', 'wma', 'ac3'
            ]
          },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (!picked || picked.length === 0) return
      const probe = await probeFile(picked[0]!)
      autoSelect(probe)
      void loadSubPreviews(probe)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  /* ---------- 字幕预览（认轨用） ---------- */

  const loadSubPreviews = async (probe: ProbeInfo): Promise<void> => {
    const exe = await runner.init()
    if (!exe) return
    const map: Record<string, string> = {}
    for (const stream of probe.streams.filter((x) => x.type === 'subtitle')) {
      if (isBitmapSub(stream)) {
        map[`s${stream.rel}`] = '（图形字幕，只能原样复制）'
        continue
      }
      const res = await api.proc
        .run({
          exe,
          args: [
            '-hide_banner', '-loglevel', 'error', '-i', probe.path,
            '-map', `0:s:${stream.rel}`, '-t', '60', '-f', 'srt', '-'
          ]
        })
        .catch(() => null)
      if (res && res.code === 0) map[`s${stream.rel}`] = subSnippet(res.stdout)
    }
    setSubPreviews((prev) => ({ ...prev, ...map }))
  }

  const addExtSub = async (): Promise<void> => {
    const picked = await api.dialog.openFiles({
      title: '选择外挂字幕',
      filters: [{ name: '字幕', extensions: ['srt', 'ass', 'ssa', 'vtt'] }]
    })
    if (!picked) return
    mut((st) => {
      for (const path of picked) {
        const extId = st.extSubs.length
        st.extSubs.push({ embedded: false, rel: 0, extId, path, name: '' })
      }
    })
    // 外挂字幕直接读文件头预览，不必再开一次 ffmpeg
    const map: Record<string, string> = {}
    for (let i = 0; i < picked.length; i++) {
      const bytes = await api.fs.read(picked[i]!).catch(() => null)
      if (bytes) map[`e${s.extSubs.length + i}`] = subSnippet(decodeText(bytes))
    }
    setSubPreviews((prev) => ({ ...prev, ...map }))
  }

  /* ---------- 抽内嵌字幕（烧入前需要落成文件） ---------- */

  const extractSub = useCallback(
    async (rel: number): Promise<string | null> => {
      const probe = stateRef.current.probe
      const exe = await runner.init()
      if (!probe || !exe || !cacheDir) return null
      const key = `s${rel}`
      const dest = `${cacheDir}/fcb_sub_${Date.now()}_${rel}.srt`
      const res = await api.proc.run({
        exe,
        args: ['-y', '-hide_banner', '-loglevel', 'error', '-i', probe.path, '-map', `0:s:${rel}`, dest]
      })
      if (res.code === 0) {
        mut((st) => {
          st.extracted[key] = dest
        })
        return dest
      }
      setError('抽取字幕失败（该字幕轨可能不是文本字幕，例如 hdmv_pgs / dvd_subtitle 无法烧入）')
      return null
    },
    [api, cacheDir, mut, runner]
  )

  /* ---------- 提交 ---------- */

  const submit = async (): Promise<void> => {
    setError(null)
    const st = stateRef.current

    // 烧入的内嵌字幕：先抽出来，再给本任务复制一份独占副本
    const mine: Record<string, string> = {}
    const burn = st.keep.subMode === 'burn' ? st.keep.subs.filter((x) => x.embedded) : []
    for (const sub of burn) {
      const key = subKey(sub)
      let shared = st.extracted[key]
      if (!shared) shared = (await extractSub(sub.rel)) ?? undefined
      if (!shared) return
      const dest = `${cacheDir}/fcb_job_${Date.now()}_${key}.srt`
      await api.fs.copy(shared, dest)
      mine[key] = dest
    }

    const { spec, error: err } = fromState(st, queue, mine)
    if (!spec) {
      setError(err)
      return
    }
    queue.enqueue(spec)
    bump()
    void runner.pump()
  }

  const batchAdd = async (): Promise<void> => {
    setError(null)
    setProbing(true)
    try {
      const picked = await api.dialog.openFiles({
        title: '批量：选择要套用当前配置的视频',
        multiple: true,
        grantParentDir: true,
        filters: [{ name: '媒体', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'ts', 'm2ts'] }]
      })
      if (!picked) return

      for (const path of picked) {
        const target = await probeFile(path)
        const cfg = stateRef.current
        const { state: batchState, notes: batchNotes, extractRequests } = forTarget(cfg, target, queue)

        const extracted: Record<string, string> = {}
        for (const req of extractRequests) {
          const exe = await runner.init()
          if (!exe) continue
          const dest = `${cacheDir}/${req.destName}`
          const res = await api.proc.run({
            exe,
            args: ['-y', '-hide_banner', '-loglevel', 'error', '-i', target.path, '-map', `0:s:${req.rel}`, dest]
          })
          if (res.code === 0) extracted[req.key] = dest
          else batchNotes.push(`字幕抽取失败，这个任务不带字幕`)
        }

        const outPath = uniquePath(batchState.out.path, queue.liveOutPaths)
        const spec = buildBatchSpec(
          batchState,
          extracted,
          outPath,
          [...new Set(batchNotes)].join('；'),
          target.duration,
          target.name
        )
        queue.enqueue(spec)
      }
      bump()
      void runner.pump()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setProbing(false)
    }
  }

  /* ---------- 校验的一键修 ---------- */

  const applyFix = (fix: Fix): void => {
    mut((st) => {
      switch (fix.kind) {
        case 'vcodec':
          st.out.vcodec = fix.value
          break
        case 'acodec':
          st.out.acodec = fix.value
          break
        case 'scale-reset':
          st.scale.w = 1920
          st.scale.h = -2
          break
        case 'container':
          st.out.container = fix.value
          st.out.pathTouched = false
          defaultOutPath(st)
          break
        case 'submode-soft':
          st.keep.subMode = 'soft'
          break
        case 'scale-on':
          st.scale.on = true
          break
        case 'out-rename': {
          st.out.pathTouched = true
          const p = st.out.path
          const slash = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
          const dir = slash >= 0 ? p.slice(0, slash + 1) : ''
          const base = slash >= 0 ? p.slice(slash + 1) : p
          const dot = base.lastIndexOf('.')
          const stem = dot > 0 ? base.slice(0, dot) : base
          const ext = dot > 0 ? base.slice(dot) : ''
          st.out.path = `${dir}${stem}_new${ext}`
          break
        }
      }
    })
  }

  /* ---------- 截图模式自动化：真视频验证 ---------- */

  useEffect(() => {
    if (!isShotMode()) return
    const ctl = (
      window as unknown as {
        __airshipShot?: {
          onAutotest?: (cb: (p: { app: string; path: string }) => void) => void
          grantRead?: (app: string, path: string) => Promise<unknown>
          listenerReady?: (app: string) => void
        }
      }
    ).__airshipShot
    if (!ctl?.onAutotest || !ctl.grantRead) return
    ctl.onAutotest((payload) => {
      if (payload.app !== 'vcp') return
      void (async () => {
        await ctl.grantRead!('vcp', payload.path)
        const probe = await probeFile(payload.path)
        autoSelect(probe)
      })().catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
    })
    ctl.listenerReady?.('vcp')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeFile])

  /* ---------- 渲染 ---------- */

  const probe = s.probe
  const videos = probe?.streams.filter((x) => x.type === 'video') ?? []
  const audios = probe?.streams.filter((x) => x.type === 'audio') ?? []
  const subs = probe?.streams.filter((x) => x.type === 'subtitle') ?? []
  const args = build(s)
  const cmd = display(args)
  const hasErrors = notes.some((n) => n.level === 'error')

  return (
    <div className="vcp">
      <header className="vcp__top">
        <button type="button" className="btn btn--primary" disabled={probing} onClick={() => void openVideo()}>
          {probing ? '探测中…' : '打开视频'}
        </button>
        <button type="button" className="btn" disabled={!probe || probing} onClick={() => void batchAdd()}>
          批量套用
        </button>
        {probe ? (
          <div className="vcp__src">
            <span className="vcp__src-name" title={probe.path}>{probe.name}</span>
            <span className="hint">
              {probe.durationText} · {probe.format} · {probe.bitrate} kb/s · {human(probe.size)} ·{' '}
              {probe.streams.length} 条流
            </span>
          </div>
        ) : (
          <span className="hint">还没打开视频</span>
        )}
        <span className="spacer" />
        {ffmpegReady === false && <span className="chip chip--bad">ffmpeg 不可用</span>}
        {ffmpegReady === true && <span className="chip chip--ok">ffmpeg 就绪</span>}
      </header>

      {error && <div className="vcp__error">{error}</div>}

      <div className="vcp__body">
        <div className="vcp__left">
          {/* 选流 */}
          <section className="card">
            <h2 className="card__title">保留哪些流</h2>
            {!probe ? (
              <p className="hint">打开视频后在这里选视频 / 音频 / 字幕轨。</p>
            ) : (
              <div className="vcp__streams">
                <div className="vcp__stream-group">
                  <span className="vcp__stream-label">视频</span>
                  <div className="row row--wrap">
                    {videos.map((v) => (
                      <label key={`v${v.rel}`} className="vcp__pick">
                        <input
                          type="radio"
                          name="vcp-video"
                          checked={s.keep.videoRel === v.rel}
                          onChange={() =>
                            mut((st) => {
                              st.keep.videoRel = v.rel
                              if (!st.out.pathTouched) defaultOutPath(st)
                            })
                          }
                        />
                        <span>
                          v:{v.rel} {v.codec} {v.w}x{v.h} {v.fps ? `${v.fps}fps` : ''}
                          {isCover(v) ? '（封面）' : ''}
                        </span>
                      </label>
                    ))}
                    <label className="vcp__pick">
                      <input
                        type="radio"
                        name="vcp-video"
                        checked={s.keep.videoRel === null}
                        onChange={() => mut((st) => void (st.keep.videoRel = null))}
                      />
                      <span>不要视频</span>
                    </label>
                  </div>
                </div>

                <div className="vcp__stream-group">
                  <span className="vcp__stream-label">音频</span>
                  <div className="row row--wrap">
                    {audios.map((a) => (
                      <label key={`a${a.rel}`} className="vcp__pick">
                        <input
                          type="checkbox"
                          checked={s.keep.audioRels.includes(a.rel)}
                          onChange={() =>
                            mut((st) => {
                              const i = st.keep.audioRels.indexOf(a.rel)
                              if (i >= 0) st.keep.audioRels.splice(i, 1)
                              else st.keep.audioRels.push(a.rel)
                            })
                          }
                        />
                        <span>
                          a:{a.rel} {a.codec} {a.lang} {a.channels}ch {a.isDefault ? '(default)' : ''}
                        </span>
                      </label>
                    ))}
                    {audios.length === 0 && <span className="hint">没有音频轨</span>}
                  </div>
                </div>

                <div className="vcp__stream-group">
                  <span className="vcp__stream-label">字幕</span>
                  <div className="row row--wrap">
                    {subs.map((sub) => (
                      <label key={`s${sub.rel}`} className="vcp__pick">
                        <input
                          type="checkbox"
                          checked={s.keep.subs.some((x) => x.embedded && x.rel === sub.rel)}
                          onChange={() => toggleSub(sub, true)}
                        />
                        <span title={subPreviews[`s${sub.rel}`] ?? ''}>
                          s:{sub.rel} {sub.codec} {sub.lang || sub.title || '未命名'}
                          {isBitmapSub(sub) ? '（图形）' : ''}
                        </span>
                      </label>
                    ))}
                    {s.extSubs.map((e) => (
                      <label key={`e${e.extId}`} className="vcp__pick">
                        <input
                          type="checkbox"
                          checked={s.keep.subs.some((x) => !x.embedded && x.extId === e.extId)}
                          onChange={() => toggleSub(e, false)}
                        />
                        <span title={subPreviews[`e${e.extId}`] ?? ''}>外:{e.extId} {subTitle(e)}</span>
                      </label>
                    ))}
                    <button type="button" className="btn btn--ghost" onClick={() => void addExtSub()}>
                      + 外挂字幕
                    </button>
                  </div>
                  <div className="row" style={{ marginTop: 8 }}>
                    <span className="hint">字幕方式</span>
                    <label className="vcp__pick">
                      <input
                        type="radio"
                        name="vcp-submode"
                        checked={s.keep.subMode === 'soft'}
                        onChange={() => mut((st) => void (st.keep.subMode = 'soft'))}
                      />
                      <span>软字幕（封装进容器）</span>
                    </label>
                    <label className="vcp__pick">
                      <input
                        type="radio"
                        name="vcp-submode"
                        checked={s.keep.subMode === 'burn'}
                        onChange={() => mut((st) => void (st.keep.subMode = 'burn'))}
                      />
                      <span>烧进画面</span>
                    </label>
                  </div>
                </div>
              </div>
            )}
          </section>

          <ProcessPanel s={s} mut={mut} />
          <OutputPanel s={s} mut={mut} api={api} />

          <section className="card">
            <h2 className="card__title">检查</h2>
            {notes.length === 0 ? (
              <p className="hint">没发现问题。</p>
            ) : (
              <ul className="vcp__notes">
                {notes.map((noteItem, i) => (
                  <li key={i} className={`vcp__note vcp__note--${noteItem.level}`}>
                    <span className="vcp__note-msg">{noteItem.msg}</span>
                    {noteItem.fix && (
                      <button type="button" className="btn btn--ghost" onClick={() => applyFix(noteItem.fix!)}>
                        {noteItem.fixLabel}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2 className="card__title">命令</h2>
            <pre className="vcp__cmd selectable">{cmd}</pre>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void api.clipboard.writeText(cmd)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? '已复制' : '复制命令'}
              </button>
              <button type="button" className="btn btn--primary" disabled={!probe || hasErrors} onClick={() => void submit()}>
                提交任务
              </button>
            </div>
          </section>
        </div>

        <aside className="vcp__right">
          <div className="row">
            <span className="vcp__queue-summary">{queue.summary}</span>
            <span className="spacer" />
            <button type="button" className="btn btn--ghost" onClick={() => runner.stopAll()}>
              全部停止
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                queue.clearFinished()
                bump()
              }}
            >
              清掉完成
            </button>
          </div>
          <div className="vcp__queue">
            {queue.jobs.length === 0 ? (
              <p className="hint">队列是空的。</p>
            ) : (
              queue.jobs.map((j) => (
                <JobRow key={j.id} j={j} onKill={() => runner.kill(j)} onRemove={() => { queue.remove(j); bump() }} />
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  )

  function toggleSub(item: StreamInfo | SubRef, embedded: boolean): void {
    mut((st) => {
      if (embedded) {
        const stream = item as StreamInfo
        const i = st.keep.subs.findIndex((x) => x.embedded && x.rel === stream.rel)
        if (i >= 0) st.keep.subs.splice(i, 1)
        else
          st.keep.subs.push({
            embedded: true,
            rel: stream.rel,
            extId: 0,
            path: '',
            name: stream.title || stream.lang
          })
      } else {
        const ref = item as SubRef
        const i = st.keep.subs.findIndex((x) => !x.embedded && x.extId === ref.extId)
        if (i >= 0) st.keep.subs.splice(i, 1)
        else st.keep.subs.push(ref)
      }
    })
  }
}

/* ================= 子面板 ================= */

interface PanelProps {
  s: AppState
  mut: (fn: (s: AppState) => void) => void
}

function ProcessPanel({ s, mut }: PanelProps): JSX.Element {
  return (
    <section className="card">
      <h2 className="card__title">处理链</h2>
      <div className="field-grid">
        <label>缩放</label>
        <div className="row">
          <Toggle on={s.scale.on} onChange={(v) => mut((st) => void (st.scale.on = v))} />
          <input className="input vcp__num" type="number" value={s.scale.w} onChange={(e) => mut((st) => void (st.scale.w = Number(e.target.value)))} />
          <span className="hint">×</span>
          <input className="input vcp__num" type="number" value={s.scale.h} onChange={(e) => mut((st) => void (st.scale.h = Number(e.target.value)))} />
          <span className="hint">-2 表示按宽度自动算偶数高</span>
        </div>

        <label>补边</label>
        <div className="row">
          <Toggle on={s.pad.on} onChange={(v) => mut((st) => void (st.pad.on = v))} />
          <input className="input vcp__num" type="number" value={s.pad.w} onChange={(e) => mut((st) => void (st.pad.w = Number(e.target.value)))} />
          <span className="hint">×</span>
          <input className="input vcp__num" type="number" value={s.pad.h} onChange={(e) => mut((st) => void (st.pad.h = Number(e.target.value)))} />
        </div>

        <label>帧率</label>
        <div className="row">
          <Toggle on={s.fps.on} onChange={(v) => mut((st) => void (st.fps.on = v))} />
          <input className="input vcp__num" type="number" value={s.fps.v} onChange={(e) => mut((st) => void (st.fps.v = Number(e.target.value)))} />
        </div>

        <label>裁剪</label>
        <div className="row">
          <Toggle on={s.trim.on} onChange={(v) => mut((st) => void (st.trim.on = v))} />
          <input className="input vcp__time" placeholder="开始 00:01:00" value={s.trim.ss} onChange={(e) => mut((st) => void (st.trim.ss = e.target.value))} />
          <span className="hint">→</span>
          <input className="input vcp__time" placeholder="结束 00:02:30" value={s.trim.to} onChange={(e) => mut((st) => void (st.trim.to = e.target.value))} />
          <label className="vcp__pick">
            <input type="checkbox" checked={s.trim.fast} onChange={(e) => mut((st) => void (st.trim.fast = e.target.checked))} />
            <span>快速定位</span>
          </label>
        </div>

        <label>色彩</label>
        <div className="row">
          <Toggle on={s.eq.on} onChange={(v) => mut((st) => void (st.eq.on = v))} />
          <span className="hint">亮</span>
          <input className="input vcp__num" type="number" step="0.05" value={s.eq.b} onChange={(e) => mut((st) => void (st.eq.b = Number(e.target.value)))} />
          <span className="hint">对比</span>
          <input className="input vcp__num" type="number" step="0.05" value={s.eq.c} onChange={(e) => mut((st) => void (st.eq.c = Number(e.target.value)))} />
          <span className="hint">饱和</span>
          <input className="input vcp__num" type="number" step="0.05" value={s.eq.s} onChange={(e) => mut((st) => void (st.eq.s = Number(e.target.value)))} />
        </div>

        <label>音量</label>
        <div className="row">
          <Toggle on={s.vol.on} onChange={(v) => mut((st) => void (st.vol.on = v))} />
          <input className="input vcp__num" type="number" step="0.1" value={s.vol.v} onChange={(e) => mut((st) => void (st.vol.v = Number(e.target.value)))} />
          <span className="hint">倍</span>
        </div>

        <label>响度归一</label>
        <Toggle on={s.loud.on} onChange={(v) => mut((st) => void (st.loud.on = v))} />

        <label>文字水印</label>
        <div className="row">
          <Toggle on={s.text.on} onChange={(v) => mut((st) => void (st.text.on = v))} />
          <input className="input" value={s.text.t} onChange={(e) => mut((st) => void (st.text.t = e.target.value))} />
          <input className="input vcp__num" type="number" value={s.text.size} onChange={(e) => mut((st) => void (st.text.size = Number(e.target.value)))} />
          <select className="select" value={s.text.pos} onChange={(e) => mut((st) => void (st.text.pos = e.target.value))}>
            {['右下', '左下', '右上', '左上'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  )
}

function OutputPanel({ s, mut, api }: PanelProps & { api: AppApi }): JSX.Element {
  const o = s.out
  return (
    <section className="card">
      <h2 className="card__title">输出</h2>
      <div className="field-grid">
        <label>容器</label>
        <select
          className="select"
          value={o.container}
          onChange={(e) =>
            mut((st) => {
              st.out.container = e.target.value
              if (!st.out.pathTouched) defaultOutPath(st)
            })
          }
        >
          {['mp4', 'mkv', 'mov', 'webm'].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <label>视频编码</label>
        <select className="select" value={o.vcodec} onChange={(e) => mut((st) => void (st.out.vcodec = e.target.value))}>
          {['libx264', 'libx265', 'copy', 'h264_nvenc', 'hevc_nvenc', 'libsvtav1'].map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <label>质量 / 速度</label>
        <div className="row">
          <span className="hint">CRF</span>
          <input className="input vcp__num" value={o.crf} onChange={(e) => mut((st) => void (st.out.crf = e.target.value))} />
          <select className="select" value={o.preset} onChange={(e) => mut((st) => void (st.out.preset = e.target.value))}>
            {['ultrafast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>

        <label>音频</label>
        <div className="row">
          <select className="select" value={o.acodec} onChange={(e) => mut((st) => void (st.out.acodec = e.target.value))}>
            {['aac', 'libopus', 'copy', 'ac3', 'eac3'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <input className="input vcp__num" value={o.abitrate} onChange={(e) => mut((st) => void (st.out.abitrate = e.target.value))} />
        </div>

        <label>选项</label>
        <div className="row">
          <label className="vcp__pick">
            <input type="checkbox" checked={o.faststart} onChange={(e) => mut((st) => void (st.out.faststart = e.target.checked))} />
            <span>faststart</span>
          </label>
          <label className="vcp__pick">
            <input type="checkbox" checked={o.pixFmt} onChange={(e) => mut((st) => void (st.out.pixFmt = e.target.checked))} />
            <span>yuv420p</span>
          </label>
        </div>

        <label>附加参数</label>
        <input className="input mono" placeholder="原样追加到命令末尾" value={o.extra} onChange={(e) => mut((st) => void (st.out.extra = e.target.value))} />

        <label>输出到</label>
        <div className="row">
          <input
            className="input vcp__path"
            value={o.path}
            onChange={(e) =>
              mut((st) => {
                st.out.path = e.target.value
                st.out.pathTouched = true
              })
            }
          />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const target = await api.dialog.saveFile({
                title: '输出到',
                defaultPath: o.path || undefined,
                filters: [{ name: '视频', extensions: [o.container] }]
              })
              if (target)
                mut((st) => {
                  st.out.path = target
                  st.out.pathTouched = true
                })
            }}
          >
            另存为
          </button>
        </div>
      </div>
    </section>
  )
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <button type="button" className={`vcp__toggle${on ? ' vcp__toggle--on' : ''}`} onClick={() => onChange(!on)}>
      <span className="vcp__toggle-knob" />
    </button>
  )
}

function JobRow({ j, onKill, onRemove }: { j: JobSpec; onKill(): void; onRemove(): void }): JSX.Element {
  return (
    <div className={`vcp__job vcp__job--${j.state}`}>
      <div className="vcp__job-head">
        <span className="vcp__job-no">#{j.no}</span>
        <span className="vcp__job-title" title={j.outPath}>{j.title}</span>
        <span className={`vcp__job-state vcp__job-state--${j.state}`}>{statusText(j)}</span>
      </div>
      {j.state === 'running' && (
        <div className="vcp__job-bar">
          <span className="vcp__job-bar-fill" style={{ width: `${j.pct}%` }} />
        </div>
      )}
      <div className="vcp__job-detail">{detailText(j)}</div>
      <div className="row" style={{ marginTop: 4 }}>
        <span className="hint mono">{j.outPath.split(/[\\/]/).pop()}</span>
        <span className="spacer" />
        {j.state === 'running' && (
          <button type="button" className="btn btn--ghost" onClick={onKill}>停止</button>
        )}
        {(j.state === 'done' || j.state === 'error' || j.state === 'killed' || j.state === 'cancelled') && (
          <button type="button" className="btn btn--ghost" onClick={onRemove}>移除</button>
        )}
      </div>
    </div>
  )
}
