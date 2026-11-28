/**
 * wsld 应用自带的后端：wslc 的可执行文件由这份文件自己找、自己起，runtime 不认识它。
 *
 * 它是随包归档的 `backend.js`（产包流水把这份文件 bundle 到包根），runtime 只负责把它
 * 起成一个 Node 进程并把调用喂进来；`child_process` 在这条线上是普通能力，不是特权。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 要流式给界面的活儿用 `{ event: true, method, payload }` 主动推——`invoke` 只等 30 秒回话，
 *     `logs -f` 会一直跟着日志跑，所以 `start` 提交即应答，输出与结束走 `job:chunk` / `job:exit`。
 *
 * 找 wslc 是这台机器上的知识，按顺序试三份来路：环境变量 `AIRSHIP_WSLC_PATH`（工装与开发用）
 *   → PATH 里的 `wslc.exe` → WSL 3 的默认安装位置 `%ProgramFiles%\WSL\wslc.exe`。
 * 找不到就返回 null：界面据此念"这台机器上没有 wslc"，编排页照常能拼命令。
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/** runtime（utilityProcess）给的消息端口——Electron 那份类型不在这里，声明够用的形状 */
interface ParentPort {
  on(event: 'message', handler: (ev: { data?: { seq?: number; method?: string; payload?: unknown } }) => void): void
  postMessage(message: unknown): void
}

interface Incoming {
  seq?: number
  method?: string
  payload?: unknown
}

interface JobPayload {
  jobId?: unknown
  args?: unknown
}

interface RunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
}

const parent = (process as unknown as { parentPort: ParentPort }).parentPort
const ENV_KEY = 'AIRSHIP_WSLC_PATH'
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
  const name = process.platform === 'win32' ? 'wslc.exe' : 'wslc'
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (dir && isFile(join(dir, name))) return join(dir, name)
  }
  return null
}

/** 发现结果留在进程里：每条命令都重扫一遍 PATH 是白给的延迟 */
function locate(force = false): string | null {
  if (searched && !force) return cached
  searched = true
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  cached = [
    process.env[ENV_KEY] ?? null,
    fromPath(),
    join(programFiles, 'WSL', 'wslc.exe')
  ].find((c): c is string => !!c && isFile(c)) ?? null
  return cached
}

function needExe(): string {
  const exe = locate()
  // 完整的那句引导语归界面（cli.ts 的 WSLC_MISSING）：这里只在漏网的调用上给个短原因
  if (!exe) throw new Error(`没找到 wslc：装好 WSL 3，或设环境变量 ${ENV_KEY} 指向它的完整路径`)
  return exe
}

function push(method: string, payload: unknown): void {
  parent.postMessage({ event: true, method, payload })
}

function argsOf(payload: unknown): string[] {
  const raw = (payload ?? {}) as JobPayload
  return Array.isArray(raw.args) ? raw.args.map((a) => String(a)) : []
}

function jobIdOf(payload: unknown): string {
  return String((payload as JobPayload)?.jobId ?? '')
}

/** 一次性跑完：列表、详情、查看几行日志——拿到完整输出才算回话 */
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

/** 流式任务：提交即应答，输出与结束经 job:chunk / job:exit 推回本窗口 */
function start(jobId: string, args: string[]): { jobId: string } {
  if (jobs.has(jobId)) throw new Error(`任务 ${jobId} 还在跑`)
  const exe = needExe()
  const child = spawn(exe, args, { windowsHide: true, env: process.env }) as ChildProcessWithoutNullStreams
  jobs.set(jobId, child)

  const decOut = new StringDecoder('utf8')
  const decErr = new StringDecoder('utf8')
  let stdout = ''
  let stderr = ''
  // 全文一并攒着（同样封顶）：结束后界面要拿 stderr 那句报错，不该再等一段流
  child.stdout.on('data', (b: Buffer) => {
    const text = decOut.write(b)
    if (stdout.length < MAX_BUFFER) stdout += text
    push('job:chunk', { jobId, stream: 'stdout', text })
  })
  child.stderr.on('data', (b: Buffer) => {
    const text = decErr.write(b)
    if (stderr.length < MAX_BUFFER) stderr += text
    push('job:chunk', { jobId, stream: 'stderr', text })
  })
  child.on('error', (err) => {
    jobs.delete(jobId)
    push('job:exit', { jobId, code: null, signal: null, stdout: '', stderr: '', error: `起不来 ${exe}：${String(err)}` })
  })
  child.on('close', (code, signal) => {
    // 解码器里剩下的半截中文要先吐完，否则报错取的那句少个尾巴
    const tailOut = decOut.end()
    const tailErr = decErr.end()
    if (tailOut) push('job:chunk', { jobId, stream: 'stdout', text: tailOut })
    if (tailErr) push('job:chunk', { jobId, stream: 'stderr', text: tailErr })
    stdout += tailOut
    stderr += tailErr
    jobs.delete(jobId)
    push('job:exit', { jobId, code, signal, stdout, stderr })
  })
  return { jobId }
}

function kill(jobId: string): boolean {
  const child = jobs.get(jobId)
  if (!child) return false
  return child.kill('SIGKILL')
}

/** 后端进程自己收摊前把名下的 wslc 带走：utilityProcess.kill 只杀这一层 */
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

/** 顶栏那两行：wslc 在不在、报的什么版本 */
async function status(): Promise<{ found: boolean; exe: string | null; version: string | null }> {
  const exe = locate(true)
  if (!exe) return { found: false, exe: null, version: null }
  const res = await run(['--version']).catch(() => null)
  const line = (res?.stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  return { found: true, exe, version: line ?? null }
}

function handle(method: string, payload: unknown): unknown {
  if (method === 'status') return status()
  if (method === 'locate') return locate(true)
  if (method === 'run') return run(argsOf(payload))
  if (method === 'start') return start(jobIdOf(payload), argsOf(payload))
  if (method === 'kill') return kill(jobIdOf(payload))
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
