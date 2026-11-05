import type { AppApi } from '../../shell/useAppApi'
import type { JobQueue, JobSpec } from './jobs'

/**
 * 任务运行器：把 JobQueue 接到壳的 proc 服务上。
 *
 * 进度解析对应 Avalonia 版 Ffmpeg.Job.Feed：
 * ffmpeg 用 `-progress pipe:1` 往 stdout 打 key=value 行，
 * out_time / speed / frame / progress=end 四种是我们要的。
 *
 * stderr 只留最近 200 行非空行，失败时取最后 6 行当报错——
 * 全量 stderr 在长任务里能到几十 MB，没必要留。
 */

const TIME_RE = /^(?:out_time|time)=(\d+:\d+:\d+\.\d+)/
const SPEED_RE = /^speed=([0-9.]+)x/
const FRAME_RE = /^frame=(\d+)/

export function feedProgress(j: JobSpec, line: string): void {
  const t = TIME_RE.exec(line)
  if (t && t[1] !== '00:00:00.000000') {
    const parts = t[1]!.split(':')
    const sec =
      Number.parseInt(parts[0]!, 10) * 3600 +
      Number.parseInt(parts[1]!, 10) * 60 +
      Number.parseFloat(parts[2]!)
    if (j.durationSec > 0) j.pct = Math.min(99.5, (sec / j.durationSec) * 100)
  }
  const sp = SPEED_RE.exec(line)
  if (sp) j.speed = `${sp[1]}x`
  if (line.startsWith('progress=end')) j.pct = 100
  void FRAME_RE.exec(line)
}

export interface RunnerOptions {
  api: AppApi
  queue: JobQueue
  /** 界面刷新回调 */
  onChange(): void
  /** 任务结束（含失败）时清理它的临时文件 */
  onFinished(j: JobSpec): void
}

export class Runner {
  private api: AppApi
  private queue: JobQueue
  private onChange: () => void
  private onFinished: (j: JobSpec) => void
  private stderrLog = new Map<string, string[]>()
  private unsub: (() => void) | null = null
  private exe: string | null = null

  constructor(options: RunnerOptions) {
    this.api = options.api
    this.queue = options.queue
    this.onChange = options.onChange
    this.onFinished = options.onFinished
  }

  async init(): Promise<string | null> {
    const shell = (window as unknown as { airshipShell?: { ffmpegPath(): Promise<string | null> } })
      .airshipShell
    this.exe = (await shell?.ffmpegPath()) ?? null
    return this.exe
  }

  /** 订阅壳的进程事件 */
  attach(): void {
    this.unsub = this.api.on((event) => {
      if (event.kind === 'proc:chunk') {
        const j = this.queue.jobs.find((x) => x.id === event.jobId)
        if (!j) return
        if (event.stream === 'stdout') {
          for (const line of event.text.split('\n')) feedProgress(j, line.trim())
        } else {
          const log = this.stderrLog.get(j.id) ?? []
          for (const line of event.text.split('\n')) {
            const t = line.trim()
            if (t.length > 0) {
              log.push(t)
              if (log.length > 200) log.shift()
            }
          }
          this.stderrLog.set(j.id, log)
        }
        this.onChange()
      } else if (event.kind === 'proc:exit') {
        this.handleExit(event.jobId, event.result.code)
      }
    })
  }

  detach(): void {
    this.unsub?.()
    this.unsub = null
  }

  private handleExit(jobId: string, code: number | null): void {
    const j = this.queue.jobs.find((x) => x.id === jobId)
    if (!j) return
    j.finishedAt = Date.now()

    if (code === 0) {
      j.state = 'done'
      j.pct = 100
      void this.api.fs
        .stat(j.outPath)
        .then((s) => {
          j.outSize = s?.size ?? 0
          this.onChange()
        })
        .catch(() => undefined)
    } else if (j.state === 'running') {
      // 被 kill 的任务在 kill() 里就已经是 'killed'，走不到这里
      j.state = 'error'
      const log = this.stderrLog.get(j.id) ?? []
      j.error = log.slice(-6).join('\n')
      if (j.error.length === 0) j.error = `ffmpeg 退出码 ${code}`
    }

    if (this.queue.running === j) this.queue.running = null
    this.onFinished(j)
    this.onChange()
    void this.pump()
  }

  /** 取下一个排队任务开跑 */
  async pump(): Promise<void> {
    if (this.queue.running) return
    const next = this.queue.nextReady()
    if (!next) return
    if (!this.exe) {
      next.state = 'error'
      next.error = '没找到 ffmpeg，去总览页看壳状态'
      this.onChange()
      return
    }

    this.queue.running = next
    next.state = 'running'
    next.startedAt = Date.now()
    this.onChange()

    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...next.args]
    try {
      await this.api.proc.start({ exe: this.exe, args, jobId: next.id })
    } catch (err) {
      next.state = 'error'
      next.error = err instanceof Error ? err.message : String(err)
      next.finishedAt = Date.now()
      this.queue.running = null
      this.onFinished(next)
      this.onChange()
      void this.pump()
    }
  }

  kill(j: JobSpec): void {
    if (j.state !== 'running') return
    j.state = 'killed'
    void this.api.proc.kill(j.id).catch(() => undefined)
  }

  stopAll(): void {
    this.queue.stopAll((j) => this.kill(j))
    this.onChange()
  }
}
