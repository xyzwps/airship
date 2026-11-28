/**
 * FFmpeg 应用自带的后端：ffmpeg 的可执行文件由这份文件自己找、自己起，runtime 不认识它。
 *
 * 它是随包归档的 `backend.js`（产包流水把这份文件 bundle 到包根），runtime 只负责把它
 * 起成一个 Node 进程并把调用喂进来；`child_process` 在这条线上是普通能力，不是特权。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 要流式给界面的活儿用 `{ event: true, method, payload }` 主动推——`invoke` 只等 30 秒回话，
 *     转码动辄几十分钟，所以 `start` 提交即应答，结束走 `job:exit` 事件。
 *
 * 找 ffmpeg 是这台机器上的知识，按顺序试四份来路：环境变量 `AIRSHIP_FFMPEG_PATH`（工装与开发用）
 *   → PATH 里的 `ffmpeg.exe` → python 的 imageio_ffmpeg 报的路径 → 已知 python 安装根下那张静态 exe。
 * 找不到就返回 null：界面据此念"ffmpeg 不可用"，命令行原样交给用户也是一条能走通的路。
 */

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** runtime（utilityProcess）给的消息端口——Electron 那份类型不在这里，声明够用的形状 */
interface ParentPort {
  on(event: 'message', handler: (ev: { data?: { seq?: number; method?: string; payload?: unknown } }) => void): void
  postMessage(message: unknown): void
}

/** 一次调用的回话：{ seq, method, payload }，payload 由各个方法自己解释 */
interface Incoming {
  seq?: number
  method?: string
  payload?: unknown
}

interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

const parent = (process as unknown as { parentPort: ParentPort }).parentPort
const ENV_KEY = 'AIRSHIP_FFMPEG_PATH'
const MAX_BUFFER = 8 * 1024 * 1024

const jobs = new Map<string, ChildProcessWithoutNullStreams>()
let cached: string | null = null
let searched = false

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** PATH 里找同名可执行文件；某个条目读不了就跳过，不让整次发现失败 */
function fromPath(): string | null {
  const name = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (dir && isFile(join(dir, name))) return join(dir, name)
  }
  return null
}

function looksLikeFfmpeg(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('ffmpeg') && (lower.endsWith('.exe') || !lower.includes('.'))
}

/** 在若干 python 安装根下摸 imageio_ffmpeg 的静态 exe */
function fromImageio(): string | null {
  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, 'Python') : null,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Python') : null,
    'C:\\Python313',
    'C:\\Python312',
    'C:\\Python311'
  ].filter((r): r is string => Boolean(r))

  for (const root of roots) {
    let pythons: string[] = []
    try {
      pythons = readdirSync(root)
    } catch {
      continue
    }
    for (const py of pythons) {
      // 两种装法：%APPDATA%/Python/Python313/site-packages 和 <安装目录>/Lib/site-packages
      for (const dir of [
        join(root, py, 'site-packages', 'imageio_ffmpeg', 'binaries'),
        join(root, py, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
      ]) {
        let files: string[] = []
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }
        const hit = files.filter(looksLikeFfmpeg).sort().pop()
        if (hit && isFile(join(dir, hit))) return join(dir, hit)
      }
    }
  }
  return null
}

/** 问 imageio_ffmpeg 自己要路径，最准，但要求 python 在 PATH 上 */
function fromPythonModule(): string | null {
  for (const py of ['python', 'python3', 'py']) {
    try {
      const res = spawnSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true
      })
      const out = (res.stdout ?? '').trim()
      if (res.status === 0 && out && isFile(out)) return out
    } catch {
      /* 没有这个解释器就试下一个 */
    }
  }
  return null
}

/** 发现结果留在进程里：每次调用重扫一遍 PATH 与几个 python 根，界面上每问一句就得等一下 */
function locate(force = false): string | null {
  if (searched && !force) return cached
  searched = true
  cached = [process.env[ENV_KEY] ?? null, fromPath(), fromPythonModule(), fromImageio()].find(
    (c): c is string => !!c && isFile(c)
  ) ?? null
  return cached
}

function needExe(): string {
  const exe = locate()
  if (!exe) throw new Error(`没找到 ffmpeg：装一个，或设环境变量 ${ENV_KEY} 指向它的完整路径`)
  return exe
}

function push(method: string, payload: unknown): void {
  parent.postMessage({ event: true, method, payload })
}

function argsOf(payload: unknown): string[] {
  const raw = (payload ?? {}) as { args?: unknown }
  return Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : []
}

/** 一次性跑完：探测、抽字幕、取 60 秒字幕预览——拿到完整输出才算回话 */
function run(args: string[]): Promise<RunResult> {
  const exe = needExe()
  return new Promise<RunResult>((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(exe, args, { windowsHide: true, env: process.env }) as ChildProcessWithoutNullStreams
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
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
}

/** 流式任务：提交即应答，进度与结束经 job:chunk / job:exit 推回本窗口 */
function start(jobId: string, args: string[]): { jobId: string } {
  if (jobs.has(jobId)) throw new Error(`任务 ${jobId} 还在跑`)
  const exe = needExe()
  const child = spawn(exe, args, { windowsHide: true, env: process.env }) as ChildProcessWithoutNullStreams
  jobs.set(jobId, child)

  const decOut = new StringDecoder('utf8')
  const decErr = new StringDecoder('utf8')
  child.stdout.on('data', (b: Buffer) => push('job:chunk', { jobId, stream: 'stdout', text: decOut.write(b) }))
  child.stderr.on('data', (b: Buffer) => push('job:chunk', { jobId, stream: 'stderr', text: decErr.write(b) }))
  child.on('error', (err) => {
    jobs.delete(jobId)
    push('job:exit', { jobId, code: null, signal: null, error: `起不来 ${exe}：${String(err)}` })
  })
  child.on('close', (code, signal) => {
    // 解码器里剩下的半截中文要先吐完，否则报错取的那几行少个尾巴
    const tail = decErr.end()
    if (tail) push('job:chunk', { jobId, stream: 'stderr', text: tail })
    jobs.delete(jobId)
    push('job:exit', { jobId, code, signal })
  })
  return { jobId }
}

function kill(jobId: string): boolean {
  const child = jobs.get(jobId)
  if (!child) return false
  // SIGKILL 直接带走：转码跑到一半停掉不该等它收尾
  return child.kill('SIGKILL')
}

/** 后端进程自己收摊前把名下的 ffmpeg 带走：utilityProcess.kill 只杀这一层 */
function killAll(): number {
  let n = 0
  for (const child of jobs.values()) {
    try {
      if (child.kill('SIGKILL')) n++
    } catch {
      /* 已经没了 */
    }
  }
  jobs.clear()
  return n
}

function handle(method: string, payload: unknown): unknown {
  if (method === 'locate') return locate(true)
  if (method === 'run') return run(argsOf(payload))
  if (method === 'start') return start(String((payload as { jobId?: unknown })?.jobId ?? ''), argsOf(payload))
  if (method === 'kill') return kill(String((payload as { jobId?: unknown })?.jobId ?? ''))
  if (method === 'killAll') return killAll()
  throw new Error(`后端不认的方法：${method}`)
}

parent.on('message', (event: { data?: Incoming }) => {
  const { seq, method, payload } = event.data ?? {}
  void Promise.resolve(handle(String(method), payload))
    .then((value) => parent.postMessage({ seq, ok: true, value }))
    .catch((e: unknown) => {
      // 回给前端的 error 就是要念给用户听的人话——别回堆栈
      parent.postMessage({ seq, ok: false, error: e instanceof Error ? e.message : String(e) })
    })
})

process.on('exit', killAll)
process.on('SIGTERM', () => {
  killAll()
  process.exit(0)
})

parent.postMessage({ ready: true })
