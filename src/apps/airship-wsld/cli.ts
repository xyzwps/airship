import { cleanWslcError, parseContainers, parseImages, type RawContainer, type RawImage } from './parse'
import type { AppApi } from '@airship/contract'

/**
 * wslc 那一侧的门。
 *
 * 命令行在这里拼，进程交给应用随包自带的后端（同目录 `backend.ts`）去起，界面只管要数据和听结果：
 *   - 一次性读（列表、查看日志、拉取收尾）走 `run`；
 *   - 要看得见"正在做"的动作（起停删、实时日志、删除镜像）走 `start`，
 *     结束由后端推回来的 `job:exit` 说了算——不然界面没法把"进行中"这段摆出来。
 *
 * 可执行文件由后端定位（三份来路见那个文件）：拿不到就按"这台机器上没有"处理，
 * 渲染侧从头到尾不知道 wslc 落在哪个目录，也不自己去摸一条路径出来跑。
 */

/** 后端 run / job:exit 的回话形状（写在这里的是应用自己的读法） */
export interface WslcResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** 起不来时的原因（连进程都没开成，没有退出码） */
  error?: string
}

/** 后端推来的一条流式输出 */
export interface WslcChunk {
  jobId: string
  stream: 'stdout' | 'stderr'
  text: string
}

export type WslcExit = WslcResult & { jobId: string }

/** 定位不到 wslc 时给用户的句子：说清下一步该怎么办，而不是一堆报错 */
export const WSLC_MISSING =
  '这台机器上没有 wslc：请安装并启用 WSL 3（自带 wslc.exe），或设环境变量 AIRSHIP_WSLC_PATH 指向它的完整路径。'

/* ---------------- 命令行 ---------------- */

/** `wslc list -a --format json`：含已停止的容器，一次读全 */
export const listContainersArgs = (): string[] => ['list', '-a', '--format', 'json']

/** `wslc images --format json` */
export const listImagesArgs = (): string[] => ['images', '--format', 'json']

export type ContainerActionName = 'start' | 'stop' | 'restart' | 'remove'

/**
 * 容器动作。ID 为空一步都不迈；删除运行中的容器必须 `-f`，
 * 不加会被引擎以"容器正在运行"拒绝（实测 WSLC_E_CONTAINER_IS_RUNNING）。
 */
export function containerActionArgs(action: ContainerActionName, id: string, force = false): string[] {
  const target = id.trim()
  if (target.length === 0) throw new Error('容器 ID 不能为空。')
  return action === 'remove' && force ? ['remove', '-f', target] : [action, target]
}

/** `wslc pull <引用>`：不用 -q，详细输出末尾那行 Status: 能区分"新下载"和"本来就最新" */
export function pullArgs(reference: string): string[] {
  return ['pull', requireReference(reference)]
}

/** `wslc rmi [-f] <引用>`：一次只交一个引用——实测多交时遇到第一个失败就停手 */
export function rmiArgs(reference: string, force = false): string[] {
  const target = requireReference(reference)
  return force ? ['rmi', '-f', target] : ['rmi', target]
}

function requireReference(reference: string): string {
  const trimmed = reference.trim()
  if (trimmed.length === 0) throw new Error('镜像引用不能为空。')
  return trimmed
}

/* ---------------- 日志请求 ---------------- */

/** 行数取这个值表示"全部"，此时不发 `-n` */
export const ALL_LINES = 0

/** 界面上能选的那几档（顺序即下拉顺序，末尾是"全部"） */
export const TAIL_CHOICES: readonly number[] = [100, 200, 500, 1000, 2000, ALL_LINES]

export const DEFAULT_TAIL_LINES = 200

/** 再大也只是把无意义的数字发给 CLI */
export const MAX_TAIL_LINES = 100_000

/**
 * 一次日志请求。两种读法各一档：查看模式带行数，实时模式带起点，
 * 走错档（跟着却拿不到起点）在拼命令那一步就拦下。
 */
export type LogQuery =
  | {
      follow: false
      containerRef: string
      /** 查看模式要看尾部几行；0 表示全部，此时不发 -n */
      tailLines: number
      timestamps: boolean
    }
  | {
      follow: true
      containerRef: string
      timestamps: boolean
      /** 实时模式的起点（Unix 秒）：跟随必须给，否则 wslc 会把全部历史冲出来 */
      sinceEpochSeconds?: number
    }

export const tailLabel = (lines: number): string =>
  lines === ALL_LINES ? '全部' : `最近 ${lines} 行`

/**
 * 拼 `logs [-f] [-t] [--since 起点] [-n 行数] <容器>`，顺序固定。
 *
 * 非法输入在这一步就挡下来：实测 `wslc logs -n 0` / `-n abc` 只换回 8 行 usage
 * 加退出码 1，对使用者毫无价值。
 */
export function logsArgs(query: LogQuery): string[] {
  const reference = query.containerRef.trim()
  if (reference.length === 0) throw new Error('容器标识不能为空。')

  const args = ['logs']
  if (query.follow) {
    const since = query.sinceEpochSeconds
    if (typeof since !== 'number' || !Number.isInteger(since) || since <= 0) {
      throw new Error('实时日志要给起点，否则会把全部历史都冲出来。')
    }
    args.push('-f')
    if (query.timestamps) args.push('-t')
    args.push('--since', String(since))
  } else {
    if (query.timestamps) args.push('-t')
    if (query.tailLines !== ALL_LINES) {
      if (
        !Number.isInteger(query.tailLines) ||
        query.tailLines < ALL_LINES ||
        query.tailLines > MAX_TAIL_LINES
      ) {
        throw new Error(`日志行数得是 ${ALL_LINES}（表示全部）到 ${MAX_TAIL_LINES} 之间的整数。`)
      }
      args.push('-n', String(query.tailLines))
    }
  }
  args.push(reference)
  return args
}

/** 点下"实时日志"那一刻的起点（Unix 秒） */
export const nowEpochSeconds = (): number => Math.floor(Date.now() / 1000)

/* ---------------- 起进程 ---------------- */

let jobSeq = 0

/** 任务标识在同一应用内要唯一，结束后由后端把那份记录摘掉 */
export function nextJobId(kind: string): string {
  jobSeq += 1
  return `${kind}-${jobSeq}`
}

export interface WslcRunner {
  readonly api: AppApi
  /** 一次性跑完，拿退出码与全文 */
  run(args: string[]): Promise<WslcResult>
  /** 后台跑，输出与结束由事件回流（提交就已应答，不等 wslc 跑完） */
  start(jobId: string, args: string[]): Promise<unknown>
  kill(jobId: string): Promise<boolean>
}

export async function locateWslc(api: AppApi): Promise<string | null> {
  return api.backend.invoke<string | null>('locate')
}

export function makeRunner(api: AppApi): WslcRunner {
  return {
    api,
    run: (args) => api.backend.invoke<WslcResult>('run', { args }),
    start: (jobId, args) => api.backend.invoke('start', { jobId, args }),
    kill: (jobId) => api.backend.invoke<boolean>('kill', { jobId })
  }
}

/**
 * 从后端推来的事件里认出某个任务的一条消息（`method` 对不上或没有任务号就给 null）。
 * 后端的主动消息都裹在 `backend:event` 里，视图层不必各自认这层壳。
 */
export function jobEvent<T>(event: { kind: string; method?: string; payload?: unknown }, method: string): T | null {
  if (event.kind !== 'backend:event' || event.method !== method) return null
  const hit = event.payload as { jobId?: unknown }
  return typeof hit?.jobId === 'string' ? (event.payload as T) : null
}

/** 非 0 退出一律换成清洗过的那句人话（见 parse.ts 的错误清洗） */
async function mustSucceed(runner: WslcRunner, args: string[], stdoutOf: (r: WslcResult) => string): Promise<string> {
  const result = await runner.run(args)
  if (result.code !== 0) throw new Error(cleanWslcError(result.stderr))
  return stdoutOf(result)
}

/** 本机容器（含已停止的） */
export async function loadContainers(runner: WslcRunner): Promise<RawContainer[]> {
  const stdout = await mustSucceed(runner, listContainersArgs(), (r) => r.stdout)
  return parseContainers(stdout)
}

/** 本机镜像：一个"仓库:标签"是一行，同一镜像 ID 可以占好几行 */
export async function loadImages(runner: WslcRunner): Promise<RawImage[]> {
  const stdout = await mustSucceed(runner, listImagesArgs(), (r) => r.stdout)
  return parseImages(stdout)
}
