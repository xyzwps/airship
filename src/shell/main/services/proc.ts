import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { isAllowedExecutable } from './tools'
import { log } from './logging'
import { dupJob, exeDenied } from '@shared/errors'
import type { AppId, ProcRequest, ProcResult, ShellEvent } from '@shared/protocol'

/**
 * 子进程服务。
 *
 * 只跑白名单里的可执行文件（白名单来历见 tools.ts 的工具表）。
 * 应用不能拿这个服务去跑任意命令。
 *
 * 两种用法：
 *   run()   一次性跑完拿完整结果，适合 -version、探测、`wslc list` 这类短命令
 *   start() 后台跑，stdout/stderr 分块推给渲染进程，适合转码、`wslc logs -f` 这类要流式的
 *
 * 分块解码用 StringDecoder：ffmpeg 与 wslc 的输出里有中文，按字节切会把多字节字符劈开，
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

/** 事件投递：第一个参数是任务归属的应用，由壳路由到那个应用自己的窗口 */
let emit: ((app: AppId, event: ShellEvent) => void) | null = null

/** 由主进程注入 */
export function setProcEmitter(fn: (app: AppId, event: ShellEvent) => void): void {
  emit = fn
}

function key(app: AppId, jobId: string): string {
  return `${app}:${jobId}`
}

function assertExecutable(exe: string): void {
  if (!isAllowedExecutable(exe)) {
    throw new Error(exeDenied(exe))
  }
}

function spawnJob(app: AppId, request: ProcRequest): Job {
  assertExecutable(request.exe)

  const k = key(app, request.jobId)
  if (jobs.has(k)) {
    throw new Error(dupJob(request.jobId))
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
    emit?.(job.app, { kind: 'proc:chunk', jobId: request.jobId, stream, text })
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
  emit?.(job.app, { kind: 'proc:exit', jobId: jobId!, result })
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

  /**
   * 关掉某个应用名下所有还在跑的子进程。
   * 应用窗口关闭时由 windows.ts 调用——转码跑到一半被关掉，不该留一个孤儿子进程继续吃 CPU。
   */
  killApp(app: AppId): number {
    const prefix = `${app}:`
    let killed = 0
    for (const k of [...jobs.keys()]) {
      if (!k.startsWith(prefix)) continue
      const job = jobs.get(k)
      if (!job) continue
      try {
        job.child.kill('SIGKILL')
        killed++
      } catch {
        /* 已经没了 */
      }
    }
    return killed
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
