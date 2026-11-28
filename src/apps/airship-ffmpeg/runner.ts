import type { AppApi } from '@airship/contract'
import type { JobQueue, JobSpec } from './jobs'

/**
 * 任务运行器：把 JobQueue 接到应用自带的后端进程上（同目录那份 `backend.ts`）。
 *
 * 渲染侧只剩 `api.backend.invoke`：ffmpeg 在哪、怎么起、怎么杀都归后端，runtime 不认识这个工具。
 * 流式任务提交就已应答（`invoke` 只等 30 秒回话，转码动辄几十分钟），进度与结束经
 * `backend:event` 的 `job:chunk` / `job:exit` 推回来。
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

/** 后端 run 的回话形状（写在这份文件里的是应用自己的读法） */
export interface FfmpegRun {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

interface JobRef {
  jobId: string
}

interface JobChunk extends JobRef {
  stream: 'stdout' | 'stderr'
  text: string
}

interface JobExit extends JobRef {
  code: number | null
  signal: string | null
  /** 起不来时的原因（连进程都没开成，没有退出码） */
  error?: string
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

  constructor(options: RunnerOptions) {
    this.api = options.api
    this.queue = options.queue
    this.onChange = options.onChange
    this.onFinished = options.onFinished
  }

  /** 问后端要 ffmpeg 的位置；界面拿它判顶栏那枚就绪/不可用 */
  init(): Promise<string | null> {
    return this.api.backend.invoke<string | null>('locate')
  }

  /** 一次性跑完拿完整输出：探测、抽字幕、取字幕预览 */
  run(args: string[]): Promise<FfmpegRun> {
    return this.api.backend.invoke<FfmpegRun>('run', { args })
  }

  /** 订阅后端推来的任务输出 */
  attach(): void {
    this.unsub = this.api.on((event) => {
      if (event.kind === 'backend:exited') {
        // 后端进程没了，在跑的那条就地判死——否则它永远停在"进行中"
        const running = this.queue.running
        if (running) this.handleExit(running.id, null, '后端程序中途退出')
        return
      }
      if (event.kind !== 'backend:event') return
      if (event.method === 'job:chunk') {
        const chunk = event.payload as JobChunk
        const j = this.queue.jobs.find((x) => x.id === chunk.jobId)
        if (!j) return
        if (chunk.stream === 'stdout') {
          for (const line of chunk.text.split('\n')) feedProgress(j, line.trim())
        } else {
          const log = this.stderrLog.get(j.id) ?? []
          for (const line of chunk.text.split('\n')) {
            const t = line.trim()
            if (t.length > 0) {
              log.push(t)
              if (log.length > 200) log.shift()
            }
          }
          this.stderrLog.set(j.id, log)
        }
        this.onChange()
      } else if (event.method === 'job:exit') {
        const exit = event.payload as JobExit
        this.handleExit(exit.jobId, exit.code, exit.error)
      }
    })
  }

  detach(): void {
    this.unsub?.()
    this.unsub = null
  }

  private handleExit(jobId: string, code: number | null, why?: string): void {
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
      j.error = log.slice(-6).join('\n') || why || `ffmpeg 退出码 ${code}`
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

    this.queue.running = next
    next.state = 'running'
    next.startedAt = Date.now()
    this.onChange()

    const args = ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...next.args]
    try {
      // 找不到 ffmpeg 由后端念出原因（那句措辞只在 backend.ts 写一份），这里原样落到这条任务上
      await this.api.backend.invoke('start', { jobId: next.id, args })
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
    void this.api.backend.invoke('kill', { jobId: j.id }).catch(() => undefined)
  }

  stopAll(): void {
    this.queue.stopAll((j) => this.kill(j))
    this.onChange()
  }
}
