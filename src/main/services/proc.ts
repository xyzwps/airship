import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isAllowedExecutable } from './tools'
import { log } from './logging'
import type { AppId, ProcRequest, ProcResult, ShellEvent } from '../../shared/protocol'

/**
 * 子进程服务。
 *
 * 只跑白名单里的可执行文件（见 tools.ts）。白名单的来源只有两个：
 * 壳自己发现/用户手动指定的 ffmpeg。应用不能拿这个服务去跑任意命令。
 *
 * 两种用法：
 *   run()   一次性跑完拿完整结果，适合 -version、探测这类短命令
 *   start() 后台跑，stdout/stderr 分块推给渲染进程，适合转码这种要显示进度的
 *
 * 分块解码用 StringDecoder：ffmpeg 输出里有中文，按字节切会把多字节字符劈开，
 * 直接 Buffer.toString() 会出乱码。
 */

const MAX_BUFFER = 8 * 1024 * 1024

interface Job {
  app: AppId
  key: string
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  truncated: boolean
}

const jobs = new Map<string, Job>()

let emit: ((event: ShellEvent) => void) | null = null

/** 由 ipc 层注入：把事件推给渲染进程 */
export function setProcEmitter(fn: (event: ShellEvent) => void): void {
  emit = fn
}

function key(app: AppId, jobId: string): string {
  return `${app}:${jobId}`
}

function assertExecutable(exe: string): void {
  if (!isAllowedExecutable(exe)) {
    throw new Error(
      `不允许执行 ${exe}：可执行文件必须先由壳发现或用户在设置里指定（见 tools.ts 的白名单规则）`
    )
  }
}

function spawnJob(app: AppId, request: ProcRequest): Job {
  assertExecutable(request.exe)

  const k = key(app, request.jobId)
  if (jobs.has(k)) {
    throw new Error(`任务标识重复：${request.jobId}（同一个应用内要唯一）`)
  }

  log.info(app, '启动子进程', { exe: request.exe, args: request.args, jobId: request.jobId })

  const child = spawn(request.exe, request.args, {
    cwd: request.cwd,
    windowsHide: true,
    // ffmpeg 在 Windows 上对管道输出不缓冲，但保险起见关掉行缓冲带来的额外开销
    env: process.env
  }) as ChildProcessWithoutNullStreams

  const job: Job = { app, key: k, child, stdout: '', stderr: '', truncated: false }
  jobs.set(k, job)

  const decOut = new StringDecoder('utf8')
  const decErr = new StringDecoder('utf8')

  const append = (stream: 'stdout' | 'stderr', text: string): void => {
    if (!text) return
    const target = stream === 'stdout' ? 'stdout' : 'stderr'
    if (job[target].length < MAX_BUFFER) {
      job[target] += text
      if (job[target].length >= MAX_BUFFER) job.truncated = true
    } else {
      job.truncated = true
    }
    emit?.({ kind: 'proc:chunk', jobId: request.jobId, stream, text })
  }

  child.stdout.on('data', (buf: Buffer) => append('stdout', decOut.write(buf)))
  child.stderr.on('data', (buf: Buffer) => append('stderr', decErr.write(buf)))

  child.on('error', (err) => {
    log.error(app, '子进程启动失败', { jobId: request.jobId, error: String(err) })
    append('stderr', `\n[airship] 无法启动 ${request.exe}: ${String(err)}\n`)
    finish(k, { code: null, signal: null, stdout: job.stdout, stderr: job.stderr })
  })

  child.on('close', (code, signal) => {
    append('stdout', decOut.end())
    append('stderr', decErr.end())
    finish(k, { code, signal, stdout: job.stdout, stderr: job.stderr })
  })

  return job
}

function finish(k: string, result: ProcResult): void {
  const job = jobs.get(k)
  if (!job) return
  jobs.delete(k)

  const [, jobId] = k.split(':')
  log.info(job.app, '子进程结束', {
    jobId,
    code: result.code,
    signal: result.signal,
    truncated: job.truncated
  })
  emit?.({ kind: 'proc:exit', jobId: jobId!, result })
}

export const proc = {
  /** 一次性跑完。不推 chunk 事件，只回最终结果。 */
  async run(app: AppId, request: Omit<ProcRequest, 'jobId'>): Promise<ProcResult> {
    assertExecutable(request.exe)
    const jobId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    return new Promise<ProcResult>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(request.exe, request.args, {
          cwd: request.cwd,
          windowsHide: true,
          env: process.env
        }) as ChildProcessWithoutNullStreams
      } catch (err) {
        reject(err)
        return
      }

      const decOut = new StringDecoder('utf8')
      const decErr = new StringDecoder('utf8')
      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (b: Buffer) => {
        if (stdout.length < MAX_BUFFER) stdout += decOut.write(b)
      })
      child.stderr.on('data', (b: Buffer) => {
        if (stderr.length < MAX_BUFFER) stderr += decErr.write(b)
      })
      child.on('error', reject)
      child.on('close', (code, signal) => {
        stdout += decOut.end()
        stderr += decErr.end()
        resolve({ code, signal, stdout, stderr })
      })
    })
  },

  start(app: AppId, request: ProcRequest): void {
    spawnJob(app, request)
  },

  kill(jobId: string, app: AppId): boolean {
    const job = jobs.get(key(app, jobId))
    if (!job) return false
    // Windows 上 kill 不掉孙子进程，但 ffmpeg 是直接的子进程，够用
    job.child.kill('SIGKILL')
    return true
  },

  list(app: AppId): string[] {
    const prefix = `${app}:`
    return [...jobs.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length))
  },

  killAll(): void {
    for (const job of jobs.values()) {
      try {
        job.child.kill('SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }
    jobs.clear()
  }
}
