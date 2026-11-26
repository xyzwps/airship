import { utilityProcess, type UtilityProcess } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  PACKAGE_BACKEND_ENTRY,
  backendAbsent,
  backendEntryUnreadable,
  backendExited,
  backendNoAnswer,
  backendNotReady,
  notRegistered
} from '@airship/contract'
import type { AppId, ShellEvent } from '@airship/contract'
import { packageFor } from './packageRegistry'
import { archiveEntryNames, readArchiveEntry } from './packageArchive'
import { appBaseDir, appCacheDir, appDataDir } from './paths'
import { log } from './logging'

/**
 * 应用自带的后台程序：一份随包归档的 Node 脚本，runtime 用 utilityProcess 为它单独起进程。
 *
 * 有没有后端不读清单、不读能力位，读**包形状**：归档根有 `backend.js` 这个条目就有
 * （源项目里的 `src/backend.ts|js` 由产包流水按约定编进来）。
 *
 * 为什么不直接 fork 包里的路径：fork 要的是磁盘上的真文件，而包是一个 zip 归档。
 * 所以启动前把包根那份 `backend.js` 落到 `~/.airship/data/<id>/backend/backend.cjs`——
 * 单文件是因为产包期已经把它 import 的东西全 bundle 进去了；
 * 影子叫 `.cjs` 是因为扩展名自带 CommonJS 声明：dev 模式的落点在作者项目树里，
 * 项目根 package.json 的 `"type": "module"` 会顺着目录找上来，`.js` 会被当 ESM 加载，
 * bundle 出来的那份第一行 `require` 就当场死掉（2026-11-24 外部项目实测复现）。
 * 这份落盘与任务栏图标同族——是可再生的派生物，不是应用数据。
 *
 * 进程间只有这一种对话（形状是档1样件实测钉下的）：
 *   runtime → 后端   `child.postMessage({ seq, method, payload })`
 *   后端 → runtime   `process.parentPort.postMessage(…)`；父侧 `child.on('message', data => …)`
 *                    ——父进程收到的**就是 payload 本身**，子进程收到的才包一层 `{ data }`。不对称是实测的。
 *   后端发三种消息：`{ ready: true }`（启动后第一件事）、
 *                    `{ seq, ok, value | error }`（回话）、
 *                    `{ event: true, method, payload }`（主动推，转成 backend:event 只给归属窗口）
 *
 * 生命周期跟着窗口走（与 proc 的转码任务同一条纪律）：窗口关了进程就收掉；
 * 它自己崩了不拖累窗口——在途的调用拿到 backendExited 那句，下一次 invoke 再拉起一个新的。
 *
 * 三道闸里的身份与参数住在 ipc.ts——和 settings、proc 那些频道一样，被调到时就假定
 * "来的人报得出身份、method 是字符串"已经判过了；"有没有后端"不归闸判，归包形状判（见上）。
 */

/** 等后端报就绪的时限；超时就把进程收掉，不留一个"永远起不来"的摊子 */
export const READY_TIMEOUT_SECONDS = 10

/** 单次调用的回话时限。todo 这类应用是毫秒级，给到分钟级只会把错误埋得更深 */
export const INVOKE_TIMEOUT_SECONDS = 30

/** 后端进程被交到的位置——env 三件套，它的数据只该落在 DATA/CACHE 里 */
function backendEnv(id: AppId): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIRSHIP_APP_ID: id,
    AIRSHIP_DATA_DIR: appDataDir(id),
    AIRSHIP_CACHE_DIR: appCacheDir(id)
  }
}

/** 后端程序在磁盘上的落点根：`~/.airship/data/<id>/backend` */
export function backendRootDir(id: AppId): string {
  return join(appBaseDir(id), 'backend')
}

/**
 * 影子在磁盘上的文件名：归档条目照旧叫 `backend.js`（那是约定），落盘却换成 `.cjs`——
 * 扩展名自带 CommonJS 声明，落在哪棵树里都不受周围 package.json 的 `type` 影响。
 */
const EXTRACTED_FILE = 'backend.cjs'

/**
 * 把包根那份 backend.js 落到磁盘，返回它的绝对路径。
 *
 * 每次都重写字节：包是活动包表里那份唯一的真，落盘只是它的影子——
 * 比对内容再决定写不写，省下的那点写盘换来的是"影子跟真身不一致还看不出来"的风险。
 */
function extractBackend(archive: string, id: AppId): string {
  const raw = readArchiveEntry(archive, PACKAGE_BACKEND_ENTRY)
  if (raw === null) throw new Error(backendEntryUnreadable(id, PACKAGE_BACKEND_ENTRY))
  const target = join(backendRootDir(id), EXTRACTED_FILE)
  mkdirSync(join(backendRootDir(id)), { recursive: true })
  writeFileSync(target, Buffer.from(raw))
  log.info(id, '后端程序已落盘', { entry: PACKAGE_BACKEND_ENTRY })
  return target
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface LiveBackend {
  child: UtilityProcess
  /** 后端报过就绪才接受新调用；在此之前 invoke 都在等同一个 starting */
  ready: boolean
  pending: Map<number, Pending>
  /** 主动关闭标记：区分"runtime 收掉的"与"它自己崩的"，后者才在日志里念退出码 */
  killing: boolean
}

/** 事件投递：由主进程注入，与 setProcEmitter 同一条路（backend:event 只回归属窗口） */
let emit: ((app: AppId, event: ShellEvent) => void) | null = null

export function setBackendEmitter(fn: (app: AppId, event: ShellEvent) => void): void {
  emit = fn
}

let seqCounter = 0

/**
 * 这个应用有没有自带后台：读包形状——归档根有没有 `backend.js` 条目。
 * 列条目名不解压内容（fflate 的 filter 判据），一次中央目录扫描，便宜。
 */
export function hasBackend(app: AppId): boolean {
  const pkg = packageFor(app)
  if (!pkg) return false
  return archiveEntryNames(pkg.archive).includes(PACKAGE_BACKEND_ENTRY)
}

/** 正在启动的那一份（含等就绪）：同应用并发 invoke 共享它，不双开进程 */
const starting = new Map<AppId, Promise<LiveBackend>>()
/** 已就绪在跑的那一份 */
const live = new Map<AppId, LiveBackend>()

function killQuietly(child: UtilityProcess): void {
  try {
    void child.kill()
  } catch {
    /* 已经没了 */
  }
}

function beginStart(app: AppId, wakeMethod: string): Promise<LiveBackend> {
  const pkg = packageFor(app)
  if (!pkg) return Promise.reject(new Error(notRegistered(app)))
  if (!hasBackend(app)) return Promise.reject(new Error(backendAbsent(app)))

  let file: string
  try {
    file = extractBackend(pkg.archive, app)
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)))
  }

  log.info(app, '启动后端程序', { entry: PACKAGE_BACKEND_ENTRY })
  let child: UtilityProcess
  try {
    child = utilityProcess.fork(file, [], { env: backendEnv(app), stdio: 'pipe' })
  } catch (e) {
    return Promise.reject(new Error(`后端程序起不来：${e instanceof Error ? e.message : String(e)}`))
  }

  const be: LiveBackend = { child, ready: false, pending: new Map(), killing: false }
  live.set(app, be)

  return new Promise<LiveBackend>((resolve, reject) => {
    // 两条独立的结算线：started 只管"起动作要不要以失败告终"（就绪前的超时/崩溃）；
    // exited 管"这份进程没了"——就绪之后退出更要收摊（在途全部拒绝、从 live 摘除），
    // 若与 started 共用一个标记，就绪后的退出就会被当成"已经结算过"而无人清理。
    let started = false
    let exited = false

    /** 就绪前的失败：收掉进程，让这一次 beginStart 以原因告终 */
    const giveUp = (err: Error): void => {
      if (started || exited) return
      started = true
      clearTimeout(timer)
      be.killing = true
      if (live.get(app) === be) live.delete(app)
      killQuietly(child)
      reject(err)
    }
    const timer = setTimeout(
      () => giveUp(new Error(backendNotReady(app, READY_TIMEOUT_SECONDS))),
      READY_TIMEOUT_SECONDS * 1000
    )

    /** 进程退出（崩了或被杀）：在途调用全部听到 backendExited；就绪前就退的，起动本身也这么收场 */
    const finish = (code: number | null): void => {
      if (exited) return
      exited = true
      clearTimeout(timer)
      if (live.get(app) === be) live.delete(app)
      for (const p of be.pending.values()) p.reject(new Error(backendExited(p.method)))
      be.pending.clear()
      // 事件任务型调用没有回话可等（提交就已应答）——靠这个事件让渲染侧把在途的活儿就地判死
      emit?.(app, { kind: 'backend:exited' })
      if (!started) {
        started = true
        reject(new Error(backendExited(wakeMethod)))
      }
      if (!be.killing) log.warn(app, '后端程序退出', { code })
    }

    // 后端进程的声音进 runtime 的日志：崩溃栈与调试输出都从这里看
    const route = (stream: NodeJS.ReadableStream | null, level: 'info' | 'warn'): void => {
      if (!stream) return
      const decoder = new StringDecoder('utf8')
      stream.on('data', (buf: Buffer) => {
        const text = decoder.write(buf).trim()
        if (text) log[level](app, level === 'warn' ? `后端 stderr：${text}` : `后端 stdout：${text}`)
      })
    }
    route(child.stdout, 'info')
    route(child.stderr, 'warn')

    child.on('message', (data: unknown) => {
      const msg = (data ?? {}) as {
        ready?: boolean
        seq?: number
        ok?: boolean
        value?: unknown
        error?: unknown
        event?: boolean
        method?: unknown
        payload?: unknown
      }
      if (!be.ready) {
        // 就绪之前的其他消息一律不看：没报就绪就先回话是后端的 bug，让它撞在超时那句上
        if (msg.ready === true) {
          be.ready = true
          started = true
          clearTimeout(timer)
          resolve(be)
        }
        return
      }
      if (typeof msg.seq === 'number') {
        const p = be.pending.get(msg.seq)
        if (!p) return
        be.pending.delete(msg.seq)
        if (msg.ok === true) p.resolve(msg.value)
        else {
          p.reject(
            new Error(
              typeof msg.error === 'string'
                ? msg.error
                : `后端程序回了失败却没给原因（method：${p.method}）`
            )
          )
        }
        return
      }
      if (msg.event === true) {
        emit?.(app, { kind: 'backend:event', method: String(msg.method ?? ''), payload: msg.payload })
      }
    })

    child.on('error', (type, location) => {
      log.error(app, '后端程序内部致命错误', { type: String(type), location: String(location) })
    })

    child.on('exit', (code) => finish(code))
  })
}

export const backendHost = {
  /** 这份包有没有自带后台（开窗口时据此决定要不要预热，判据是包形状不是清单） */
  hasBackend,

  /**
   * 确保后端在跑并等它报就绪；已在跑 / 在起都复用同一份，不双开。
   * 起不来时抛人读的原因：窗口预热只记日志，invoke 原样上抛给应用。
   * wakeMethod 只在"就绪前就崩了"那句里露脸：预热写'起动'，invoke 交出自己的方法名。
   */
  ensure(app: AppId, wakeMethod = '起动'): Promise<LiveBackend> {
    const running = live.get(app)
    if (running?.ready) return Promise.resolve(running)
    const begun = starting.get(app)
    if (begun) return begun
    const promise = beginStart(app, wakeMethod)
    starting.set(app, promise)
    const clear = (): void => {
      if (starting.get(app) === promise) starting.delete(app)
    }
    promise.then(clear, clear)
    return promise
  },

  /** 一次请求-回话。身份 / 能力 / 参数已由 ipc.ts 判过 */
  async invoke(app: AppId, method: string, payload: unknown): Promise<unknown> {
    const be = await backendHost.ensure(app, method)
    const seq = ++seqCounter
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        be.pending.delete(seq)
        reject(new Error(backendNoAnswer(method, INVOKE_TIMEOUT_SECONDS)))
      }, INVOKE_TIMEOUT_SECONDS * 1000)
      be.pending.set(seq, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        }
      })
      be.child.postMessage({ seq, method, payload })
    })
  },

  /** 窗口关了：收掉它名下的后端（与 proc.killApp 同一站） */
  kill(app: AppId): void {
    starting.delete(app)
    const be = live.get(app)
    if (!be) return
    be.killing = true
    live.delete(app)
    for (const p of be.pending.values()) p.reject(new Error(backendExited(p.method)))
    be.pending.clear()
    log.info(app, '后端程序已随窗口关闭')
    killQuietly(be.child)
  },

  killAll(): void {
    for (const app of [...live.keys()]) backendHost.kill(app)
  },

  /** 工装与诊断：某个应用现在有没有活后端 */
  isRunning(app: AppId): boolean {
    return live.has(app)
  },

  /** 工装：进程级状态清干净（用例之间不串） */
  resetForTests(): void {
    backendHost.killAll()
    starting.clear()
  }
}
