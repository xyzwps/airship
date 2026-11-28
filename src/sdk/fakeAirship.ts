import {
  backendAbsent,
  needString,
  nsDenied,
  pathEscape,
  readDenied,
  writeDenied
} from '@airship/contract'
import type {
  AirshipBridge,
  AppApi,
  AppPaths,
  DirEntry,
  DroppedFile,
  FileStat,
  NotifyOptions,
  OpenFilesOptions,
  SaveFileOptions,
  SharedNamespace,
  ShellEvent,
  ShellEventListener,
  ThemeSnapshot,
  TrayState
} from '@airship/contract'

/**
 * runtime 的测试替身 —— 应用侧用例的地基，地位等同 wslc-desktop 里的 FakeWslcCli。
 *
 * 它按契约把 `window.airship` 装成一个内存里的小 runtime：
 *   - 拒绝措辞**直接从 shared/errors 取**（那里是唯一的措辞真源），
 *     所以越界、未声明名单这类场景里用户看到的那句中文，在测试里就是真实界面里的那句；
 *   - 文件走一个内存卷，授权规则与 runtime 一致：自己的 data/cache 自由读写，
 *     声明过的共享命名空间可读写，别的路径必须先用对话框"选中"；
 *   - 后端程序由 `backend` 那条替身应答，命令行与 payload 全记下来供断言，
 *     它主动推的事件经 `ctl.event` 走真实订阅通道。
 *
 * 它**不是**主进程的复刻：runtime 自己的规则（授权、越界、路由）另有对真实模块跑的用例
 * （tests/runtime/*）。这里只求给应用一个可信的 runtime，让应用的册子能钉住"用户看得见什么"。
 *
 * 路径一律用正斜杠的假路径（`/fake/.airship/...`，与真布局同形状：家目录 = `~/.airship`），大小写敏感——
 * 真 runtime 在 Windows 上不区分大小写，但用例里的路径都由用例自己写出来，不存在歧义。
 */

const ROOT = '/fake/.airship'

type Content = string | Uint8Array

export interface FakeOptions {
  id: string
  sharedNamespaces?: SharedNamespace[]
  /** 预置文件：假路径 → 内容 */
  files?: Record<string, Content>
  /** 预置目录 */
  dirs?: string[]
  /** 对话框依次要"选中"的结果，一次一个 */
  picks?: Array<string[] | string | null>
  theme?: ThemeSnapshot
  /**
   * 假后端的应答：按 method 给值（可异步）。不装的话 invoke 会喊出来——
   * 缺什么要响亮，别把"没装后端"吞成"后端回了 undefined"。
   * ctl.event 模拟后端主动推事件（backend:event 只给本窗口，与 backendHost 同一条通道）。
   */
  backend?: (method: string, payload: unknown, ctl: BackendCtl) => unknown | Promise<unknown>
  /**
   * 拖放名 → 本机路径的对照表，喂给 fs.pathForFile：
   * 真 runtime 里这个名字由浏览器在 drop 事件里给（webUtils.getPathForFile），
   * 表里没有的就是空字符串——与"JS 自造的 File 没有盘上真身"同形。
   */
  dropPaths?: Record<string, string>
}

/** 用例模拟后端主动行为的把手 */
export interface BackendCtl {
  event(method: string, payload?: unknown): void
}

export class FakeAirship implements AirshipBridge {
  readonly id: string
  readonly sharedNamespaces: SharedNamespace[]

  /** 内存卷 */
  readonly vol = new Map<string, Content>()
  readonly dirSet = new Set<string>()
  /** 用户经对话框给出去的授权 */
  readonly readGrants = new Set<string>()
  readonly writeGrants = new Set<string>()

  /** 记录与断言用的账本 */
  readonly backendCalls: Array<{ method: string; payload: unknown }> = []
  readonly settingsLog: Array<['get' | 'set' | 'dump', string]> = []
  readonly notifications: NotifyOptions[] = []
  readonly logs: Array<{ level: 'info' | 'warn' | 'error'; message: string; detail?: unknown }> = []
  readonly windowCalls: string[] = []
  /** 应用交给标题栏中段的标题（null = 收回） */
  readonly windowTitles: Array<string | null> = []
  trayState: TrayState | null = null
  /** 应用写进假剪贴板的最后一句话（桥上的 clipboard 是方法对象，两者不能同名） */
  clipboardText = ''
  settingsStore: Record<string, unknown> = {}

  private readonly picks: Array<string[] | string | null>
  private readonly listeners = new Set<ShellEventListener>()
  private pickIndex = 0

  constructor(private readonly opts: FakeOptions) {
    this.id = opts.id
    this.sharedNamespaces = opts.sharedNamespaces ?? []
    this.picks = [...(opts.picks ?? [])]
    for (const [p, c] of Object.entries(opts.files ?? {})) this.vol.set(p, c)
    for (const d of opts.dirs ?? []) this.dirSet.add(d)
    // 应用自己的目录与声明过的共享区天然存在（真 runtime 在启动时就建好了）
    for (const d of [this.dataDir, this.cacheDir, ...this.sharedRoots()]) this.dirSet.add(d)
  }

  /* ---------------- 测试侧的手脚 ---------------- */

  get dataDir(): string {
    return `${ROOT}/data/${this.id}`
  }

  get cacheDir(): string {
    return `${ROOT}/data/${this.id}/cache`
  }

  sharedDir(ns: SharedNamespace): string {
    return `${ROOT}/shared/${ns}`
  }

  /** 直接往卷里写，不经任何闸门（造场景用） */
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

  /** 把事件推给应用（后端主动推的、托盘点击、窗口最大化…） */
  emit(event: ShellEvent): void {
    for (const fn of [...this.listeners]) fn(event)
  }

  /* ---------------- 闸门 ---------------- */

  private needString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(needString(label, value))
    return value
  }

  static norm(p: string): string {
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

  /**
   * `on`/`paths`/`theme`/`setTheme` 写成箭头字段而不是类方法：
   * `get api()` 是 `{ ...this }`——原型方法不会被展开带走，
   * 应用从 `api.on(...)` 订事件时丢的就是这条通道。
   */
  readonly paths = async (): Promise<AppPaths> => {
    const shared: Partial<Record<SharedNamespace, string>> = {}
    for (const ns of this.sharedNamespaces) shared[ns] = this.sharedDir(ns)
    return {
      data: this.dataDir,
      cache: this.cacheDir,
      root: ROOT,
      shared,
      platform: 'win32',
      runtimeVersion: '0.0.0-test'
    }
  }

  readonly theme = async (): Promise<ThemeSnapshot> => this.themeSnapshot()

  /**
   * 改本应用的主题档。窗口观感族，**不走 settings 面**——
   * 与主进程 theme:set 同一套规矩：写 'theme'/'lastResolved' 两个键，不广播。
   */
  readonly setTheme = async (mode: ThemeSnapshot['mode'], resolvedHint?: 'light' | 'dark'): Promise<ThemeSnapshot> => {
    this.needString(mode, 'mode')
    if (!['light', 'dark', 'system'].includes(mode)) throw new Error(`不认识的主题档：${mode}`)
    this.settingsStore['theme'] = { mode }
    const fallback = this.themeSnapshot().resolved
    const resolved =
      mode === 'system'
        ? resolvedHint === 'dark' || resolvedHint === 'light'
          ? resolvedHint
          : ((this.settingsStore['lastResolved'] as 'light' | 'dark' | undefined) ?? fallback)
        : mode
    this.settingsStore['lastResolved'] = resolved
    return { mode, resolved }
  }

  /** 与主进程 readThemeFor 同一套读法：先看设置里的档，没有才用预置 */
  private themeSnapshot(): ThemeSnapshot {
    const stored = this.settingsStore['theme'] as { mode?: ThemeSnapshot['mode'] } | undefined
    const mode = stored?.mode ?? this.opts.theme?.mode ?? 'system'
    const resolved =
      mode === 'system'
        ? ((this.settingsStore['lastResolved'] as 'light' | 'dark' | undefined) ?? this.opts.theme?.resolved ?? 'dark')
        : mode
    return { mode, resolved }
  }

  readonly settings = {
    get: async <T,>(key: string, fallback: T): Promise<T> => {
      this.settingsLog.push(['get', key])
      const hit = this.settingsStore[key]
      return hit === undefined ? fallback : (hit as T)
    },
    set: async <T,>(key: string, value: T): Promise<void> => {
      this.needString(key, 'key')
      this.settingsLog.push(['set', key])
      if (value === undefined) delete this.settingsStore[key]
      else this.settingsStore[key] = value
    },
    dump: async (): Promise<Record<string, unknown>> => {
      this.settingsLog.push(['dump', '-'])
      return { ...this.settingsStore }
    }
  }

  readonly dialog = {
    openFiles: async (options?: OpenFilesOptions): Promise<string[] | null> => {
      const hit = this.nextPick()
      if (hit === null) return null
      const picked = Array.isArray(hit) ? hit : [hit]
      for (const p of picked) {
        this.readGrants.add(p)
        if (options?.grantParentDir) this.readGrants.add(parentOf(p))
      }
      return picked
    },
    openDirectory: async (options?: { title?: string }): Promise<string | null> => {
      const hit = this.nextPick()
      const dir = Array.isArray(hit) ? (hit[0] ?? null) : hit
      if (dir) this.readGrants.add(dir)
      return dir
    },
    saveFile: async (options?: SaveFileOptions): Promise<string | null> => {
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
      const p = this.needString(path, 'path')
      this.assertRead(p)
      const hit = this.vol.get(p)
      if (hit === undefined) throw new Error(`读不到文件：${p}`)
      return typeof hit === 'string' ? Buffer.from(hit, 'utf8') : Buffer.from(hit)
    },
    readRange: async (path: string, start: number, length: number): Promise<Uint8Array> => {
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
      const p = this.needString(path, 'path')
      this.assertWrite(p)
      this.vol.set(p, typeof data === 'string' ? data : new Uint8Array(data))
      this.dirSet.add(parentOf(p))
    },
    stat: async (path: string): Promise<FileStat | null> => {
      const p = this.needString(path, 'path')
      this.assertRead(p)
      if (this.dirSet.has(FakeAirship.norm(p))) return { size: 0, isDirectory: true, mtimeMs: 0 }
      const hit = this.vol.get(p)
      if (hit === undefined) return null
      const size = typeof hit === 'string' ? Buffer.byteLength(hit, 'utf8') : hit.length
      return { size, isDirectory: false, mtimeMs: 0 }
    },
    list: async (dir: string): Promise<DirEntry[]> => {
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
      const d = this.needString(dir, 'dir')
      this.assertWrite(d)
      this.dirSet.add(FakeAirship.norm(d))
    },
    remove: async (path: string): Promise<void> => {
      const p = this.needString(path, 'path')
      this.assertWrite(p)
      this.vol.delete(p)
      this.dirSet.delete(FakeAirship.norm(p))
    },
    copy: async (src: string, dest: string): Promise<void> => {
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
      const namespace = this.needString(ns, 'ns') as SharedNamespace
      if (!this.sharedNamespaces.includes(namespace)) {
        throw new Error(nsDenied(this.id, namespace))
      }
      const clean = segments.map((s) => this.needString(s, 'segment'))
      const base = this.sharedDir(namespace)
      const target = [base, ...clean].join('/')
      if (!FakeAirship.inside(base, target)) throw new Error(pathEscape(clean, `共享命名空间 ${namespace}`))
      return target
    },
    pathForFile: (file: DroppedFile): string => this.opts.dropPaths?.[file.name] ?? ''
  }

  readonly backend = {
    invoke: async <T,>(method: string, payload?: unknown): Promise<T> => {
      const m = this.needString(method, 'method')
      // 与真机同判据：有没有后端看"包"——替身里 options.backend 没装就等于包里没有 backend.js
      if (!this.opts.backend) throw new Error(backendAbsent(this.id))
      this.backendCalls.push({ method: m, payload })
      const ctl: BackendCtl = {
        event: (em, ep) => this.emit({ kind: 'backend:event', method: em, payload: ep })
      }
      return (await this.opts.backend(m, payload, ctl)) as T
    }
  }

  readonly tray = {
    set: async (state: TrayState): Promise<void> => {
      this.trayState = state
    },
    clear: async (): Promise<void> => {
      this.trayState = null
    }
  }

  readonly notify = {
    show: async (options: NotifyOptions): Promise<void> => {
      this.notifications.push(options)
    }
  }

  readonly clipboard = {
    writeText: async (text: string): Promise<void> => {
      this.clipboardText = text
    },
    readText: async (): Promise<string> => {
      return this.clipboardText
    }
  }

  readonly log = {
    info: async (message: string, detail?: unknown): Promise<void> => {
      this.logs.push({ level: 'info', message, detail })
    },
    warn: async (message: string, detail?: unknown): Promise<void> => {
      this.logs.push({ level: 'warn', message, detail })
    },
    error: async (message: string, detail?: unknown): Promise<void> => {
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

  readonly on = (listener: ShellEventListener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 装配成应用真正拿到的 AppApi */
  get api(): AppApi {
    return { ...this, id: this.id }
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
