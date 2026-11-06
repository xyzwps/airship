import {
  capDenied,
  dupJob,
  exeDenied,
  needString,
  nsDenied,
  pathEscape,
  readDenied,
  toolDenied,
  writeDenied
} from '@shared/errors'
import type {
  AirshipBridge,
  AppApi,
  AppPaths,
  Capability,
  DirEntry,
  FileStat,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  ProcResult,
  SaveFileOptions,
  SharedNamespace,
  ShellEvent,
  ShellEventListener,
  ThemeSnapshot,
  TrayState,
  ToolName
} from '@shared/protocol'

/**
 * 壳的测试替身 —— 应用侧用例的地基，地位等同 wslc-desktop 里的 FakeWslcCli。
 *
 * 它按契约把 `window.airship` 装成一个内存里的小壳：
 *   - 能力闸门照主进程的样子判，**措辞直接从 shared/errors 取**（那里是唯一的措辞真源），
 *     所以"应用没声明 settings 时用户看到的那句中文"在测试里就是真实界面里的那句；
 *   - 文件走一个内存卷，授权规则与壳一致：自己的 data/cache 自由读写，
 *     声明过的共享命名空间可读写，别的路径必须先用对话框"选中"；
 *   - proc 只跑已解析的工具路径（白名单），命令行全记下来供断言；
 *     `start` 出去的流式任务由用例自己喂 chunk 与 exit，事件走真实订阅通道。
 *
 * 它**不是**主进程的复刻：壳自己的规则（授权、越界、路由）另有对真实模块跑的用例
 * （tests/shell/*）。这里只求给应用一个可信的壳，让应用的册子能钉住"用户看得见什么"。
 *
 * 路径一律用正斜杠的假路径（`/fake/userData/...`），大小写敏感——
 * 真壳在 Windows 上不区分大小写，但用例里的路径都由用例自己写出来，不存在歧义。
 */

const ROOT = '/fake/userData'

type Content = string | Uint8Array

export interface StartCall extends ProcRequest {
  jobId: string
}

/** 一条流式任务的控制把手：用例用它把输出一点点推给应用 */
export interface StreamCtl {
  chunk(stream: 'stdout' | 'stderr', text: string): void
  exit(result?: Partial<ProcResult>): void
}

export interface FakeOptions {
  id: string
  capabilities?: Capability[]
  sharedNamespaces?: SharedNamespace[]
  tools?: ToolName[]
  /** 预置文件：假路径 → 内容 */
  files?: Record<string, Content>
  /** 预置目录 */
  dirs?: string[]
  /** 壳已发现的外部工具；null = 这台机器上没有 */
  toolPaths?: Partial<Record<ToolName, string | null>>
  /** 一次性调用的应答：按命令行决定，不填就是干净退出 */
  run?: (exe: string, args: string[]) => Partial<ProcResult>
  /** 流式调用的应答：不填就立刻成功退出 */
  start?: (call: StartCall, ctl: StreamCtl) => void
  /** 对话框依次要"选中"的结果，一次一个 */
  picks?: Array<string[] | string | null>
  theme?: ThemeSnapshot
}

export class FakeAirship implements AirshipBridge {
  readonly id: string
  readonly capabilities: Set<Capability>
  readonly sharedNamespaces: SharedNamespace[]
  readonly declaredTools: ToolName[]

  /** 内存卷 */
  readonly vol = new Map<string, Content>()
  readonly dirSet = new Set<string>()
  /** 用户经对话框给出去的授权 */
  readonly readGrants = new Set<string>()
  readonly writeGrants = new Set<string>()

  /** 记录与断言用的账本 */
  readonly procCalls: Array<{ exe: string; args: string[]; jobId?: string }> = []
  readonly settingsLog: Array<['get' | 'set' | 'dump', string]> = []
  readonly notifications: NotifyOptions[] = []
  readonly logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; detail?: unknown }> = []
  readonly windowCalls: string[] = []
  /** 应用交给标题栏中段的标题（null = 收回） */
  readonly windowTitles: Array<string | null> = []
  trayState: TrayState | null = null
  clipboard = ''
  settingsStore: Record<string, unknown> = {}

  private readonly toolPaths: Partial<Record<ToolName, string | null>>
  private readonly picks: Array<string[] | string | null>
  private readonly listeners = new Set<ShellEventListener>()
  private readonly jobs = new Map<string, StreamCtl>()
  private pickIndex = 0

  constructor(private readonly opts: FakeOptions) {
    this.id = opts.id
    this.capabilities = new Set(opts.capabilities ?? [])
    this.sharedNamespaces = opts.sharedNamespaces ?? []
    this.declaredTools = opts.tools ?? []
    this.toolPaths = opts.toolPaths ?? {}
    this.picks = [...(opts.picks ?? [])]
    for (const [p, c] of Object.entries(opts.files ?? {})) this.vol.set(p, c)
    for (const d of opts.dirs ?? []) this.dirSet.add(d)
    // 应用自己的目录与声明过的共享区天然存在（真壳在启动时就建好了）
    for (const d of [this.dataDir, this.cacheDir, ...this.sharedRoots()]) this.dirSet.add(d)
  }

  /* ---------------- 测试侧的手脚 ---------------- */

  get dataDir(): string {
    return `${ROOT}/apps/${this.id}/data`
  }

  get cacheDir(): string {
    return `${ROOT}/apps/${this.id}/cache`
  }

  sharedDir(ns: SharedNamespace): string {
    return `${ROOT}/shared/${ns}`
  }

  /** 直接往卷里写，不经能力与授权闸门（造场景用） */
  seed(path: string, content: Content): void {
    this.vol.set(path, content)
  }

  text(path: string): string {
    const hit = this.vol.get(path)
    if (hit === undefined) throw new Error(`假卷里没有 ${path}`)
    return typeof hit === 'string' ? hit : Buffer.from(hit).toString('utf8')
  }

  /** 有没有这条授权（授权只在本次"进程生命周期"内有效） */
  hasReadGrant(path: string): boolean {
    return this.readGrants.has(path)
  }

  /** 把事件推给应用（子进程输出、托盘点击、主题变更…） */
  emit(event: ShellEvent): void {
    for (const fn of [...this.listeners]) fn(event)
  }

  /** 用例主动结束一条流式任务 */
  finishJob(jobId: string, result: Partial<ProcResult> = {}): void {
    const ctl = this.jobs.get(jobId)
    if (!ctl) throw new Error(`没有这个在跑的任务：${jobId}`)
    ctl.exit(result)
  }

  /* ---------------- 闸门 ---------------- */

  private needCap(cap: Capability): void {
    if (!this.capabilities.has(cap)) throw new Error(capDenied(this.id, cap))
  }

  private needString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(needString(label, value))
    return value
  }

  private static norm(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '')
  }

  private static inside(base: string, target: string): boolean {
    const b = FakeAirship.norm(base)
    const t = FakeAirship.norm(target)
    return t === b || t.startsWith(`${b}/`)
  }

  private ownSpace(p: string): boolean {
    return (
      FakeAirship.inside(this.dataDir, p) ||
      FakeAirship.inside(this.cacheDir, p) ||
      this.sharedRoots().some((root) => FakeAirship.inside(root, p))
    )
  }

  private sharedRoots(): string[] {
    return this.sharedNamespaces.map((ns) => this.sharedDir(ns))
  }

  private granted(set: Set<string>, p: string): boolean {
    for (const g of set) if (FakeAirship.inside(g, p)) return true
    return false
  }

  private assertRead(p: string): void {
    if (!this.ownSpace(p) && !this.granted(this.readGrants, p)) throw new Error(readDenied(p))
  }

  private assertWrite(p: string): void {
    if (!this.ownSpace(p) && !this.granted(this.writeGrants, p)) throw new Error(writeDenied(p))
  }

  /* ---------------- 契约实现 ---------------- */

  async paths(): Promise<AppPaths> {
    const shared: Partial<Record<SharedNamespace, string>> = {}
    for (const ns of this.sharedNamespaces) shared[ns] = this.sharedDir(ns)
    return {
      data: this.dataDir,
      cache: this.cacheDir,
      root: ROOT,
      shared,
      platform: 'win32',
      shellVersion: '0.0.0-test'
    }
  }

  async theme(): Promise<ThemeSnapshot> {
    return this.opts.theme ?? { mode: 'system', resolved: 'dark' }
  }

  readonly settings = {
    get: async <T,>(key: string, fallback: T): Promise<T> => {
      this.needCap('settings')
      this.settingsLog.push(['get', key])
      const hit = this.settingsStore[key]
      return hit === undefined ? fallback : (hit as T)
    },
    set: async <T,>(key: string, value: T): Promise<void> => {
      this.needCap('settings')
      this.needString(key, 'key')
      this.settingsLog.push(['set', key])
      if (value === undefined) delete this.settingsStore[key]
      else this.settingsStore[key] = value
    },
    dump: async (): Promise<Record<string, unknown>> => {
      this.needCap('settings')
      this.settingsLog.push(['dump', '-'])
      return { ...this.settingsStore }
    }
  }

  readonly dialog = {
    openFiles: async (options?: OpenFilesOptions): Promise<string[] | null> => {
      this.needCap('dialog')
      const picked = this.nextPick()
      if (!picked) return null
      for (const p of picked) {
        this.readGrants.add(p)
        if (options?.grantParentDir) this.readGrants.add(parentOf(p))
      }
      return picked
    },
    openDirectory: async (options?: { title?: string }): Promise<string | null> => {
      this.needCap('dialog')
      const hit = this.nextPick()
      const dir = Array.isArray(hit) ? (hit[0] ?? null) : hit
      if (dir) this.readGrants.add(dir)
      return dir
    },
    saveFile: async (options?: SaveFileOptions): Promise<string | null> => {
      this.needCap('dialog')
      const hit = this.nextPick()
      const target = Array.isArray(hit) ? (hit[0] ?? null) : hit
      if (target) {
        this.writeGrants.add(target)
        this.readGrants.add(parentOf(target))
      }
      return target
    }
  }

  readonly fs = {
    read: async (path: string): Promise<Uint8Array> => {
      this.needCap('fs.read')
      const p = this.needString(path, 'path')
      this.assertRead(p)
      const hit = this.vol.get(p)
      if (hit === undefined) throw new Error(`读不到文件：${p}`)
      return typeof hit === 'string' ? Buffer.from(hit, 'utf8') : Buffer.from(hit)
    },
    readRange: async (path: string, start: number, length: number): Promise<Uint8Array> => {
      this.needCap('fs.read')
      const p = this.needString(path, 'path')
      this.assertRead(p)
      const hit = this.vol.get(p)
      if (hit === undefined) throw new Error(`读不到文件：${p}`)
      const buf = typeof hit === 'string' ? Buffer.from(hit, 'utf8') : Buffer.from(hit)
      if (!Number.isInteger(start) || start < 0) throw new Error(`start 必须是非负整数，收到 ${start}`)
      if (!Number.isInteger(length) || length < 0) throw new Error(`length 必须是非负整数，收到 ${length}`)
      const readable = Math.max(0, Math.min(length, buf.length - start))
      return new Uint8Array(buf.subarray(start, start + readable))
    },
    write: async (path: string, data: Uint8Array | string): Promise<void> => {
      this.needCap('fs.write')
      const p = this.needString(path, 'path')
      this.assertWrite(p)
      this.vol.set(p, typeof data === 'string' ? data : new Uint8Array(data))
      this.dirSet.add(parentOf(p))
    },
    stat: async (path: string): Promise<FileStat | null> => {
      this.needCap('fs.read')
      const p = this.needString(path, 'path')
      this.assertRead(p)
      if (this.dirSet.has(FakeAirship.norm(p))) return { size: 0, isDirectory: true, mtimeMs: 0 }
      const hit = this.vol.get(p)
      if (hit === undefined) return null
      const size = typeof hit === 'string' ? Buffer.byteLength(hit, 'utf8') : hit.length
      return { size, isDirectory: false, mtimeMs: 0 }
    },
    list: async (dir: string): Promise<DirEntry[]> => {
      this.needCap('fs.read')
      const d = FakeAirship.norm(this.needString(dir, 'dir'))
      this.assertRead(d)
      const out: DirEntry[] = []
      for (const [p, c] of this.vol) {
        if (parentOf(p) !== d) continue
        out.push({
          name: baseOf(p),
          path: p,
          isDirectory: false,
          size: typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.length
        })
      }
      for (const sub of this.dirSet) {
        if (parentOf(sub) === d && sub !== d) out.push({ name: baseOf(sub), path: sub, isDirectory: true, size: 0 })
      }
      return out.sort((a, b) => a.name.localeCompare(b.name))
    },
    ensureDir: async (dir: string): Promise<void> => {
      this.needCap('fs.write')
      const d = this.needString(dir, 'dir')
      this.assertWrite(d)
      this.dirSet.add(FakeAirship.norm(d))
    },
    remove: async (path: string): Promise<void> => {
      this.needCap('fs.write')
      const p = this.needString(path, 'path')
      this.assertWrite(p)
      this.vol.delete(p)
      this.dirSet.delete(FakeAirship.norm(p))
    },
    copy: async (src: string, dest: string): Promise<void> => {
      this.needCap('fs.read')
      this.needCap('fs.write')
      const s = this.needString(src, 'src')
      const d = this.needString(dest, 'dest')
      this.assertRead(s)
      this.assertWrite(d)
      const hit = this.vol.get(s)
      if (hit === undefined) throw new Error(`读不到文件：${s}`)
      this.vol.set(FakeAirship.norm(d), hit)
    },
    resolveInData: async (...segments: string[]): Promise<string> => {
      const clean = segments.map((s) => this.needString(s, 'segment'))
      const target = [this.dataDir, ...clean].join('/')
      if (!FakeAirship.inside(this.dataDir, target)) throw new Error(pathEscape(clean, `${this.id} 的数据目录`))
      return target
    },
    resolveInShared: async (ns: SharedNamespace, ...segments: string[]): Promise<string> => {
      const namespace = this.needString(ns, 'ns')
      if (!this.capabilities.has('shared') || !this.sharedNamespaces.includes(namespace)) {
        throw new Error(nsDenied(this.id, namespace))
      }
      const clean = segments.map((s) => this.needString(s, 'segment'))
      const base = this.sharedDir(namespace)
      const target = [base, ...clean].join('/')
      if (!FakeAirship.inside(base, target)) throw new Error(pathEscape(clean, `共享命名空间 ${namespace}`))
      return target
    }
  }

  readonly proc = {
    run: async (request: Omit<ProcRequest, 'jobId'>): Promise<ProcResult> => {
      this.needCap('proc')
      const exe = this.needString(request.exe, 'request.exe')
      this.assertWhitelisted(exe)
      this.procCalls.push({ exe, args: request.args })
      const part = this.opts.run?.(exe, request.args) ?? {}
      return { code: 0, signal: null, stdout: '', stderr: '', ...part }
    },
    start: async (request: ProcRequest): Promise<void> => {
      this.needCap('proc')
      const exe = this.needString(request.exe, 'request.exe')
      const jobId = this.needString(request.jobId, 'request.jobId')
      this.assertWhitelisted(exe)
      if (this.jobs.has(jobId)) throw new Error(dupJob(jobId))
      this.procCalls.push({ exe, args: request.args, jobId })
      const ctl: StreamCtl = {
        chunk: (stream, text) => this.emit({ kind: 'proc:chunk', jobId, stream, text }),
        exit: (result = {}) => {
          this.jobs.delete(jobId)
          this.emit({
            kind: 'proc:exit',
            jobId,
            result: { code: 0, signal: null, stdout: '', stderr: '', ...result }
          })
        }
      }
      this.jobs.set(jobId, ctl)
      if (this.opts.start) this.opts.start({ ...request, exe, jobId }, ctl)
      else ctl.exit()
    },
    kill: async (jobId: string): Promise<boolean> => {
      this.needCap('proc')
      if (!this.jobs.has(jobId)) return false
      this.finishJob(jobId, { code: null, signal: 'SIGKILL' })
      return true
    },
    list: async (): Promise<string[]> => {
      this.needCap('proc')
      return [...this.jobs.keys()]
    }
  }

  readonly tools = {
    path: async (name: ToolName): Promise<string | null> => {
      this.needCap('proc')
      if (!this.declaredTools.includes(name)) throw new Error(toolDenied(this.id, name))
      return this.toolPaths[name] ?? null
    }
  }

  readonly tray = {
    set: async (state: TrayState): Promise<void> => {
      this.needCap('tray')
      this.trayState = state
    },
    clear: async (): Promise<void> => {
      this.needCap('tray')
      this.trayState = null
    }
  }

  readonly notify = {
    show: async (options: NotifyOptions): Promise<void> => {
      this.needCap('notify')
      this.notifications.push(options)
    }
  }

  readonly clipboard = {
    writeText: async (text: string): Promise<void> => {
      this.needCap('clipboard')
      this.clipboard = text
    },
    readText: async (): Promise<string> => {
      this.needCap('clipboard')
      return this.clipboard
    }
  }

  readonly log = {
    info: async (message: string, detail?: unknown): Promise<void> => {
      this.needCap('log')
      this.logs.push({ level: 'info', message, detail })
    },
    warn: async (message: string, detail?: unknown): Promise<void> => {
      this.needCap('log')
      this.logs.push({ level: 'warn', message, detail })
    },
    error: async (message: string, detail?: unknown): Promise<void> => {
      this.needCap('log')
      this.logs.push({ level: 'error', message, detail })
    }
  }

  readonly window = {
    minimize: async (): Promise<void> => {
      this.windowCalls.push('minimize')
    },
    toggleMaximize: async (): Promise<void> => {
      this.windowCalls.push('toggleMaximize')
    },
    close: async (): Promise<void> => {
      this.windowCalls.push('close')
    },
    isMaximized: async (): Promise<boolean> => false,
    setTitle: async (title: string | null): Promise<void> => {
      this.windowTitles.push(title)
    }
  }

  on(listener: ShellEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 装配成应用真正拿到的 AppApi */
  get api(): AppApi {
    return { id: this.id, ...this }
  }

  private assertWhitelisted(exe: string): void {
    const allowed = Object.values(this.toolPaths).filter((v): v is string => Boolean(v))
    if (!allowed.includes(exe)) throw new Error(exeDenied(exe))
  }

  private nextPick(): string[] | string | null {
    const hit = this.picks[this.pickIndex++]
    return hit === undefined ? null : hit
  }
}

function parentOf(p: string): string {
  const clean = FakeAirship.norm(p)
  const i = clean.lastIndexOf('/')
  return i <= 0 ? '/' : clean.slice(0, i)
}

function baseOf(p: string): string {
  const clean = FakeAirship.norm(p)
  return clean.slice(clean.lastIndexOf('/') + 1)
}
