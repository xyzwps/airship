/**
 * 壳与应用之间的能力契约。
 *
 * 这是 airship 唯一重要的文件：应用能做什么，全部由这里声明，
 * 其余一概拿不到。preload 只按这张表暴露，主进程只按这张表实现。
 *
 * 注意边界性质：一个应用一个窗口一个渲染进程，所以 capabilities 是**强制边界**而不只是约定——
 * 主进程按 event.sender 反查归属再查能力表，应用既看不到 ipcRenderer，也冒充不了别的应用。
 * 加接口就在这一层加，实现（主进程）与桥（preload）都跟着这张表走。
 */

/**
 * 应用 id。
 *
 * 值来自各应用自己的清单（`apps/<id>/app.ts`），由壳在构建时发现并收集。
 * 这里刻意**不**维护一份 id 名单——那样每加一个应用就得回来改契约文件，
 * 违反不变量 I-5（加应用不改壳侧任何文件）。
 *
 * 代价是 TS 不再穷举 id，改成运行时校验（主进程 `appRegistry.isKnownApp`）。
 * 可以接受：应用代码从不传自己的 id，id 由壳绑定注入（见 shell/api）。
 */
export type AppId = string

/**
 * 设置作用域：应用各自的命名空间，外加壳自己的 'shell'。
 * 壳级设置（主题、窗口状态、ffmpeg 路径、最近打开的应用）不属于任何应用，
 * 硬塞进某个应用的命名空间会造成莫名的耦合，所以单列一档。
 */
export type SettingsScope = AppId | 'shell'

/**
 * 壳托管的共享命名空间登记表。
 *
 * 与应用 id 不同，这份名单**属于壳**：目录由壳创建、由壳托管，
 * 新增一个共享数据区是壳的功能变更，不是应用变更。
 * 应用只能在清单里声明自己要访问哪个，声明了不存在的直接拒。
 *
 * 为什么需要它：books（EPUB/MOBI）和 pdf 是两个独立应用入口，
 * 但书架、导入记录、封面、阅读进度是同一套数据。
 * 各自存一份就会出现"同一本书在两个入口里各有一本"的重复。
 */
export const SHARED_NAMESPACES = ['library'] as const
export type SharedNamespace = (typeof SHARED_NAMESPACES)[number]

/**
 * 运行平台。用界面语言里的名字，不把 `win32` 这种 Node 的实现细节写进清单。
 * 对应关系由 `platformIdOf` 一处给出，主进程、启动器、测试替身都问它。
 */
export const PLATFORM_IDS = ['windows', 'macos', 'linux'] as const
export type PlatformId = (typeof PLATFORM_IDS)[number]

/** Node 的 process.platform → 清单里的平台名；认不出来的算 'unknown' */
export function platformIdOf(nodePlatform: string): PlatformId | 'unknown' {
  if (nodePlatform === 'win32') return 'windows'
  if (nodePlatform === 'darwin') return 'macos'
  if (nodePlatform === 'linux') return 'linux'
  return 'unknown'
}

/**
 * 壳认识的外部工具登记表。
 *
 * 与共享命名空间同理，这份名单**属于壳**：怎么发现、拿什么标志校验它是真的，
 * 是壳的能力，不是应用的说法。应用只能在清单里声明"我要用哪一个"，
 * 声明了壳不认识的、或没声明就想用的，一律拒（措辞见 shared/errors.ts）。
 *
 * proc 白名单的来历因此仍然只有两个：壳按这张表发现的、或用户在设置里指定并通过校验的。
 */
export const TOOL_NAMES = ['ffmpeg', 'wslc'] as const
export type ToolName = (typeof TOOL_NAMES)[number]


/** 应用能力位。应用在自己的 manifest 里声明，壳按声明放行。 */
export type Capability =
  /** 读文件：限应用数据目录内，或本次会话中用户通过系统对话框显式选中的路径 */
  | 'fs.read'
  /** 写文件：限应用数据目录内 */
  | 'fs.write'
  /** 弹系统文件/目录选择框（选中结果自动进入本应用的可读路径集合） */
  | 'dialog'
  /** 读写本应用命名空间下的设置项 */
  | 'settings'
  /** 访问壳级共享命名空间（见 SHARED_NAMESPACES），具体哪几个由 manifest 声明 */
  | 'shared'
  /** 派生子进程并接收 stdout/stderr 流（vcp 的 ffmpeg 编排用） */
  | 'proc'
  /** 托盘图标与提示文字（dagogo 替代 Android 桌面小组件） */
  | 'tray'
  /** 系统通知 */
  | 'notify'
  /** 剪贴板 */
  | 'clipboard'
  /** 写日志（日志按应用分命名空间） */
  | 'log'

export interface AppPaths {
  /** 本应用私有数据目录，读写默认落在这里 */
  data: string
  /** 本应用缓存目录，可随时整体删除重建 */
  cache: string
  /** 壳的全局数据根目录 */
  root: string
  /** 本应用有权访问的共享命名空间根目录 */
  shared: Partial<Record<SharedNamespace, string>>
  /** 平台标识，值同 process.platform */
  platform: string
  /** 壳版本 */
  shellVersion: string
}

export interface OpenFilesOptions {
  title?: string
  /** Electron 标准过滤器，如 [{ name: '电子书', extensions: ['epub', 'mobi'] }] */
  filters?: { name: string; extensions: string[] }[]
  multiple?: boolean
  /**
   * 同时把选中文件的父目录加入本应用的可读集合。
   * 给"输出默认落在源文件同目录"这类应用用（vcp）：
   * 不授权父目录，"输出文件已存在"这类校验就永远查不到。
   * 默认 false——只授文件本身是最小授权。
   */
  grantParentDir?: boolean
}

export interface SaveFileOptions {
  title?: string
  defaultPath?: string
  filters?: { name: string; extensions: string[] }[]
}

export interface FileStat {
  size: number
  isDirectory: boolean
  mtimeMs: number
}

export interface DirEntry {
  name: string
  path: string
  isDirectory: boolean
  size: number
}

export interface ProcRequest {
  /** 可执行文件路径，必须是壳允许的（见 main/services/proc.ts 的白名单规则） */
  exe: string
  args: string[]
  cwd?: string
  /** 交给壳的标识，事件回流时原样带回 */
  jobId: string
}

export interface ProcResult {
  code: number | null
  /** 结束信号名，如 'SIGKILL'；正常退出为 null。用 string 而不是 NodeJS.Signals，
   *  因为这是跨进程传过来的值，类型不该依赖主进程那边的 Node 定义。 */
  signal: string | null
  stdout: string
  stderr: string
}

export interface TrayState {
  /** 悬停提示文字 */
  tooltip: string
  /**
   * 徽标文字，如 "3/5"。
   * 只给 badge 时壳仅更新提示文字，图标保持默认——
   * Windows 托盘图标是位图，主进程没有画字的能力。
   * 要真的画出带数字的图标，应用侧用 shell/renderTrayIcon() 生成 dataURL 一起传。
   */
  badge?: string
  /** 16x16 图标的 PNG dataURL，由渲染侧生成后传入 */
  iconDataUrl?: string
  /** 点击托盘时把窗口唤到前台 */
  focusOnClick?: boolean
}

export interface NotifyOptions {
  title: string
  body: string
  silent?: boolean
}

/** 壳 → 渲染进程的事件频道 */
/** 主题快照：mode 是用户选的档，resolved 是实际生效的亮/暗 */
export interface ThemeSnapshot {
  mode: 'light' | 'dark' | 'system'
  resolved: 'light' | 'dark'
}

export type ShellEvent =
  | { kind: 'proc:chunk'; jobId: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'proc:exit'; jobId: string; result: ProcResult }
  | { kind: 'tray:click' }
  | { kind: 'window:maximized'; value: boolean }
  /** 壳级广播：启动器改了主题，所有窗口跟着换 */
  | { kind: 'theme:changed'; value: ThemeSnapshot }

export type ShellEventListener = (event: ShellEvent) => void

/**
 * 应用侧看到的表面（`window.airship`）。
 *
 * **没有 app 参数**：身份由该窗口的 preload 从启动参数里注入，主进程再用
 * `event.sender` 反查归属二次确认。应用既看不到"传 id"这个动作，
 * 也就没法冒充别的应用。
 *
 * 线格式（preload ↔ 主进程）仍然带 id，那是实现细节，不进契约。
 */
export interface AirshipBridge {
  paths(): Promise<AppPaths>

  /** 读当前主题。应用侧只读，改主题在启动器 */
  theme(): Promise<ThemeSnapshot>

  settings: {
    get<T>(key: string, fallback: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
    /** 一次拿全，避免逐键往返 */
    dump(): Promise<Record<string, unknown>>
  }

  dialog: {
    openFiles(options?: OpenFilesOptions): Promise<string[] | null>
    openDirectory(options?: { title?: string }): Promise<string | null>
    saveFile(options?: SaveFileOptions): Promise<string | null>
  }

  fs: {
    read(path: string): Promise<Uint8Array>
    /** 范围读：EPUB/MOBI 的 zip 随机访问走这里，避免整本搬进内存 */
    readRange(path: string, start: number, length: number): Promise<Uint8Array>
    write(path: string, data: Uint8Array | string): Promise<void>
    stat(path: string): Promise<FileStat | null>
    list(dir: string): Promise<DirEntry[]>
    ensureDir(dir: string): Promise<void>
    remove(path: string): Promise<void>
    copy(src: string, dest: string): Promise<void>
    /** 把路径解析到应用数据目录下，返回绝对路径；越界直接抛错 */
    resolveInData(...segments: string[]): Promise<string>
    /**
     * 把路径解析到壳级共享命名空间下。
     * 应用必须在自己的清单里声明了该命名空间，否则主进程拒绝。
     */
    resolveInShared(ns: SharedNamespace, ...segments: string[]): Promise<string>
  }

  proc: {
    /** 一次性跑完拿结果（探测类短命令） */
    run(request: Omit<ProcRequest, 'jobId'>): Promise<ProcResult>
    /** 后台跑，进度通过 proc:chunk / proc:exit 事件回流到本窗口 */
    start(request: ProcRequest): Promise<void>
    kill(jobId: string): Promise<boolean>
    list(): Promise<string[]>
  }

  /**
   * 壳已发现的外部工具。要 proc 能力，**并且**要在自己的清单 `tools` 里声明过这一个。
   * 应用既不能自己找一个来跑，也不能借壳发现的名义跑没声明的工具。
   */
  tools: { path(name: ToolName): Promise<string | null> }

  tray: {
    set(state: TrayState): Promise<void>
    clear(): Promise<void>
  }

  notify: { show(options: NotifyOptions): Promise<void> }

  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> }

  log: {
    info(message: string, detail?: unknown): Promise<void>
    warn(message: string, detail?: unknown): Promise<void>
    error(message: string, detail?: unknown): Promise<void>
  }

  /** 作用于本窗口 */
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
    /**
     * 把"正在看什么"交给标题栏中段（`null` 收回）。
     * 书名是应用的内容，不是窗口名字：任务栏那侧念的是「墨读 · 书名」，
     * 窗口里那行中段念的是书名本身。
     */
    setTitle(title: string | null): Promise<void>
  }

  /** 订阅壳事件（只收本窗口该收到的），返回退订函数 */
  on(listener: ShellEventListener): () => void
}

/**
 * 应用拿到的 API：契约 + 自己的 id。
 *
 * 放在契约层而不是壳的 UI 层，是因为共享包也要用它——共享包属于依赖图的下层，
 * 反过来依赖壳的界面代码就破了自己定的规则。
 * id 只用于显示与日志，不参与任何权限判定（身份在 preload 与 event.sender 那里）。
 */
export type AppApi = AirshipBridge & { id: AppId }

/**
 * 启动器窗口专用的面（`window.airshipShell`）。
 *
 * 启动器是壳自己，不是应用，所以它要的东西和应用的完全不同：
 * 列应用、开应用、改主题、看诊断。反过来应用拿不到这些，
 * 免得某个应用能把别的窗口关掉。
 */
export interface ShellBridge {
  /** 打开（或聚焦）某个应用的独立窗口 */
  openApp(id: string): Promise<void>
  /** 当前开着哪些应用窗口 */
  openApps(): Promise<string[]>
  /**
   * 改主题并广播给所有窗口。
   * mode 是 'system' 时，实际亮暗由启动器用 matchMedia 算好传进来——
   * 主进程没有 matchMedia，不该去猜。
   */
  setTheme(mode: ThemeSnapshot['mode'], resolvedHint?: 'light' | 'dark'): Promise<ThemeSnapshot>
  theme(): Promise<ThemeSnapshot>
  /** 壳级设置读写（主题、窗口状态、ffmpeg 路径、上次应用） */
  settings: {
    get<T>(key: string, fallback: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
  }
  /** 壳自己的目录（诊断页显示数据落在哪） */
  rootPaths(): Promise<AppPaths>
  /** 这台机器的平台名，启动器按它过滤格子 */
  currentPlatform(): Promise<PlatformId | 'unknown'>
  /** 工具发现状态（诊断页显示"ffmpeg 就绪 / 不可用"） */
  toolPath(name: ToolName): Promise<string | null>
  /** 用户手动指定工具路径：校验通过才记住并加白名单 */
  setToolPath(name: ToolName, exe: string): Promise<{ ok: boolean; error?: string }>
  /** 某应用当前被授权的路径数，诊断用 */
  grants(app: string): Promise<{ read: number; write: number }>
  /** 打开系统浏览器（只放行 http/https） */
  openExternal(url: string): Promise<void>
  /** 每个窗口的内存，诊断用 */
  metrics(): Promise<{ label: string; workingSetKB: number }[]>
  window: AirshipBridge['window']
  on(listener: ShellEventListener): () => void
}

declare global {
  interface Window {
    airship: AirshipBridge
    airshipShell: ShellBridge
  }
}
