import { build, defaultOutPath } from './command'
import {
  cloneState,
  human,
  isBitmapSub,
  isCover,
  subKey,
  subTitle,
  type AppState,
  type ProbeInfo,
  type StreamInfo,
  type SubRef
} from './state'

/**
 * 任务与队列，对应 Avalonia 版 Logic/Jobs.cs。
 *
 * 一次转换的冻结快照：提交之后界面怎么改都不影响它。
 * 串行队列：一次只跑一个，跑完自动取下一个；失败不挡后面的任务。
 */

export type JobState = 'queued' | 'running' | 'done' | 'error' | 'killed' | 'cancelled'

export interface JobSpec {
  id: string
  no: number
  /** 源文件名 */
  title: string
  /** 完整 ffmpeg 参数，末尾是输出路径 */
  args: string[]
  outPath: string
  durationSec: number
  /** 本任务独占的临时字幕，跑完就删 */
  tempFiles: string[]
  state: JobState
  error: string
  /** 提交时该说的话：改名、批量没配上的部分 */
  note: string
  outSize: number
  /* 运行时进度 */
  pct: number
  speed: string
  startedAt: number | null
  finishedAt: number | null
}

export function isFinished(j: JobSpec): boolean {
  return j.state === 'done' || j.state === 'error' || j.state === 'killed' || j.state === 'cancelled'
}

function eta(j: JobSpec): string {
  if (!j.startedAt || j.pct <= 2) return ''
  const elapsed = (Date.now() - j.startedAt) / 1000
  const left = (elapsed * (100 - j.pct)) / j.pct
  if (left < 5) return '快好了'
  const m = Math.floor(left / 60)
  const s = Math.floor(left % 60)
  return `约剩 ${m}:${String(s).padStart(2, '0')}`
}

export function statusText(j: JobSpec): string {
  switch (j.state) {
    case 'queued':
      return '排队中'
    case 'running':
      return j.startedAt ? `进行中 ${Math.round(j.pct)}%` : '启动中'
    case 'done':
      return `已完成 ${human(j.outSize)}`
    case 'error':
      return '失败'
    case 'killed':
      return '已停止'
    default:
      return '已取消'
  }
}

/** 行里第二列：跑动时给速度和剩余时间，失败时给最后一行报错 */
export function detailText(j: JobSpec): string {
  if (j.state === 'running' && j.startedAt) {
    const bits: string[] = []
    if (j.speed.length > 0) bits.push(j.speed)
    const e = eta(j)
    if (e.length > 0) bits.push(e)
    bits.push(`已用 ${Math.round((Date.now() - j.startedAt) / 1000)} 秒`)
    return bits.join(' · ')
  }
  if (j.state === 'error') {
    const lines = j.error.split('\n').filter((l) => l.trim().length > 0)
    return lines.length > 0 ? lines[lines.length - 1]! : '失败'
  }
  return j.note
}

export class JobQueue {
  jobs: JobSpec[] = []
  running: JobSpec | null = null
  private nextNo = 1

  enqueue(j: JobSpec): JobSpec {
    j.no = this.nextNo++
    this.jobs.push(j)
    return j
  }

  get pending(): number {
    return this.jobs.filter((j) => j.state === 'queued').length
  }

  get busy(): boolean {
    return this.running !== null || this.pending > 0
  }

  /** 列表里出现过的输出路径都算占着：跑完的也算，免得后一个任务把前一个的成品盖掉 */
  get liveOutPaths(): string[] {
    return this.jobs.map((j) => j.outPath)
  }

  nextReady(): JobSpec | null {
    if (this.running !== null) return null
    return this.jobs.find((j) => j.state === 'queued') ?? null
  }

  /** 停掉正在跑的（kill 由调用方给，队列自己不知道进程怎么杀），排队的全部标取消 */
  stopAll(killRunning?: (j: JobSpec) => void): void {
    if (this.running) killRunning?.(this.running)
    for (const j of this.jobs) if (j.state === 'queued') j.state = 'cancelled'
  }

  clearFinished(discard?: (j: JobSpec) => void): number {
    const gone = this.jobs.filter(
      (j) =>
        (j.state === 'done' || j.state === 'killed' || j.state === 'cancelled') &&
        j !== this.running
    )
    for (const j of gone) discard?.(j)
    this.jobs = this.jobs.filter((j) => !gone.includes(j))
    if (this.running && !this.jobs.includes(this.running)) this.running = null
    return gone.length
  }

  remove(j: JobSpec, discard?: (j: JobSpec) => void): boolean {
    if (j === this.running || !isFinished(j)) return false
    const i = this.jobs.indexOf(j)
    if (i < 0) return false
    this.jobs.splice(i, 1)
    discard?.(j)
    return true
  }

  get summary(): string {
    const bits: string[] = []
    const run = this.jobs.filter((j) => j.state === 'running').length
    const done = this.jobs.filter((j) => j.state === 'done').length
    const bad = this.jobs.filter((j) => j.state === 'error').length
    const stopped = this.jobs.filter((j) => j.state === 'killed' || j.state === 'cancelled').length
    if (run > 0) bits.push(`进行中 ${run}`)
    if (this.pending > 0) bits.push(`排队 ${this.pending}`)
    if (done > 0) bits.push(`完成 ${done}`)
    if (bad > 0) bits.push(`失败 ${bad}`)
    if (stopped > 0) bits.push(`停止 ${stopped}`)
    return bits.length > 0 ? bits.join(' · ') : '队列空'
  }
}

/** 队列里已经有同名输出就自动 _2、_3，别让两个任务互相覆盖 */
export function uniquePath(path: string, taken: string[]): string {
  const set = new Set(taken.map((t) => t.toLowerCase()))
  if (!set.has(path.toLowerCase())) return path
  const slash = path.lastIndexOf('/')
  const bs = path.lastIndexOf('\\')
  const cut = Math.max(slash, bs)
  const dir = cut >= 0 ? path.slice(0, cut + 1) : ''
  const base = cut >= 0 ? path.slice(cut + 1) : path
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 2; i < 100; i++) {
    const cand = `${dir}${stem}_${i}${ext}`
    if (!set.has(cand.toLowerCase())) return cand
  }
  return path
}

let tempSeq = 0

function ownTempPath(key: string): string {
  const d = new Date()
  const pad = (v: number): string => String(v).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  tempSeq += 1
  return `fcb_job_${stamp}_${tempSeq}_${key}.srt`
}

export interface FromStateResult {
  spec: JobSpec | null
  error: string
}

/**
 * 把界面上这份配置冻结成任务。
 * mine 是"烧入字幕 key → 本任务独占的临时文件绝对路径"，由调用方复制好后传入；
 * 任务快照持有自己的副本，界面之后怎么改都不影响它。
 */
export function fromState(
  s: AppState,
  q: JobQueue,
  mine: Record<string, string>
): FromStateResult {
  if (!s.probe) return { spec: null, error: '还没打开视频。' }

  const burn = burnEmbedded(s)
  for (const sub of burn) {
    const shared = s.extracted[subKey(sub)]
    if (!shared) return { spec: null, error: '字幕还没抽出来，稍一下再提交。' }
  }

  const want = s.out.path.length > 0 ? s.out.path : `out.${s.out.container}`
  const outPath = uniquePath(want, q.liveOutPaths)

  const spec: JobSpec = {
    id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    no: 0,
    title: s.probe.name,
    args: [],
    outPath,
    durationSec: s.probe.duration,
    tempFiles: Object.values(mine),
    state: 'queued',
    error: '',
    note: '',
    outSize: 0,
    pct: 0,
    speed: '',
    startedAt: null,
    finishedAt: null
  }

  spec.args = build(s, mine)
  spec.args[spec.args.length - 1] = outPath
  if (outPath.toLowerCase() !== want.toLowerCase()) {
    spec.note = `输出和队列里已有的撞名，改名 ${outPath.split(/[\\/]/).pop()}`
  }
  return { spec, error: '' }
}

function burnEmbedded(s: AppState) {
  return s.keep.subMode === 'burn' ? s.keep.subs.filter((x) => x.embedded) : []
}

export interface ForTargetResult {
  spec: JobSpec | null
  error: string
}

/**
 * 批量：处理与输出设置照抄，流按目标文件重新选；对不上号的写进 note。
 * 对应 Avalonia 版 Jobs.ForTargetAsync。
 *
 * 与单发的差别：烧入字幕要按目标文件重新抽，抽取是异步的且要落盘，
 * 所以这里返回"需要抽哪些字幕"（extractRequests），由调用方抽完回填 extracted 再 build。
 */
export interface ExtractRequest {
  key: string
  rel: number
  destName: string
}

export function forTarget(
  cfg: AppState,
  target: ProbeInfo,
  q: JobQueue
): { state: AppState; notes: string[]; extractRequests: ExtractRequest[] } {
  const notes: string[] = []
  const s = cloneState(cfg)
  s.probe = target

  const v = target.streams.find((x) => x.type === 'video' && !isCover(x))
  s.keep.videoRel = v?.rel ?? null
  if (!v) notes.push('没有正片视频流')

  if (cfg.keep.audioRels.length > 0) {
    s.keep.audioRels = []
    const langs = cfg.keep.audioRels.map(
      (r) => cfg.probe?.streams.find((x) => x.type === 'audio' && x.rel === r)?.lang ?? ''
    )
    for (const lang of langs) {
      const free = (x: StreamInfo): boolean =>
        x.type === 'audio' && !s.keep.audioRels.includes(x.rel)
      const hit =
        (lang.length > 0
          ? target.streams.find((x) => free(x) && x.lang.toLowerCase() === lang.toLowerCase())
          : null) ??
        target.streams.find((x) => free(x) && x.isDefault) ??
        target.streams.find(free)
      if (hit) s.keep.audioRels.push(hit.rel)
    }
    if (s.keep.audioRels.length < langs.length)
      notes.push(`音频只配上 ${s.keep.audioRels.length}/${langs.length} 条`)
  } else {
    s.keep.audioRels = []
  }

  const kept: SubRef[] = []
  for (const sub of cfg.keep.subs) {
    if (!sub.embedded) {
      notes.push('外部字幕文件对不上号，批量不带')
      continue
    }
    const src = cfg.probe?.streams.find((x) => x.type === 'subtitle' && x.rel === sub.rel)
    const hit =
      (src && src.title.length > 0
        ? target.streams.find((x) => x.type === 'subtitle' && x.title === src.title)
        : null) ??
      (src && src.lang.length > 0
        ? target.streams.find(
            (x) => x.type === 'subtitle' && x.lang === src.lang && !isBitmapSub(x)
          )
        : null) ??
      (src && src.lang.length > 0
        ? target.streams.find((x) => x.type === 'subtitle' && x.lang === src.lang)
        : null)
    if (!hit) {
      notes.push(`没找到「${subTitle(sub)}」对应的字幕轨，这个文件不带字幕`)
      continue
    }
    if (cfg.keep.subMode === 'burn' && isBitmapSub(hit)) {
      notes.push(`「${subTitle(sub)}」在这条里是图形字幕，烧不进画面，跳过`)
      continue
    }
    kept.push({ embedded: true, rel: hit.rel, extId: 0, path: '', name: hit.title })
  }
  s.keep.subs = kept

  s.out.pathTouched = false
  defaultOutPath(s)
  const outPath = uniquePath(s.out.path, q.liveOutPaths)
  if (outPath.toLowerCase() !== s.out.path.toLowerCase())
    notes.push(`输出撞名，改名 ${outPath.split(/[\\/]/).pop()}`)

  const extractRequests: ExtractRequest[] = burnEmbedded(s).map((sub) => ({
    key: subKey(sub),
    rel: sub.rel,
    destName: ownTempPath(subKey(sub))
  }))

  return { state: s, notes, extractRequests }
}

/** 批量任务收尾：抽完字幕后 build 参数 */
export function buildBatchSpec(
  s: AppState,
  extracted: Record<string, string>,
  outPath: string,
  note: string,
  durationSec: number,
  title: string
): JobSpec {
  const spec: JobSpec = {
    id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    no: 0,
    title,
    args: build(s, extracted),
    outPath,
    durationSec,
    tempFiles: Object.values(extracted),
    state: 'queued',
    error: '',
    note,
    outSize: 0,
    pct: 0,
    speed: '',
    startedAt: null,
    finishedAt: null
  }
  spec.args[spec.args.length - 1] = outPath
  return spec
}
