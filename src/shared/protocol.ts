/**
 * 壳与应用之间的能力契约。
 *
 * 这是 airship 唯一重要的文件：应用能做什么，全部由这里声明，
 * 其余一概拿不到。preload 只按这张表暴露，主进程只按这张表实现。
 *
 * 注意边界性质：现在四个应用和壳跑在同一个渲染进程里，
 * 所以 capabilities 是**设计边界**而非安全边界——它约束的是"你应该只用这些"，
 * 不是"你只能用这些"。等真要拆成独立包 + iframe 时，这张表不用改，
 * 变的只是执行方式（进程内调用 → 跨进程 RPC），这也是为什么它值得现在就写死。
 */

export const APP_IDS = ['vcp', 'books', 'pdf', 'dagogo'] as const
export type AppId = (typeof APP_IDS)[number]

/**
 * 设置作用域：应用各自的命名空间，外加壳自己的 'shell'。
 * 壳级设置（主题、窗口状态、ffmpeg 路径、最近打开的应用）不属于任何应用，
 * 硬塞进某个应用的命名空间会造成莫名的耦合，所以单列一档。
 */
export type SettingsScope = AppId | 'shell'

/**
 * 壳级共享命名空间。
 *
 * 为什么需要它：books（EPUB/MOBI/TXT）和 pdf 是两个独立应用入口，
 * 但书架、导入记录、封面、阅读进度是同一套数据。
 * 各自存一份就会出现"同一本书在两个入口里各有一本"的重复，
 * 所以书库落在壳的共享区，两个应用都声明 library 命名空间来访问。
 *
 * 这也是插件系统迟早要有的东西——应用之间要共享数据，
 * 必须由壳托管，不能让它们互相摸对方的私有目录。
 */
export const SHARED_NAMESPACES = ['library'] as const
export type SharedNamespace = (typeof SHARED_NAMESPACES)[number]

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
export type ShellEvent =
  | { kind: 'proc:chunk'; jobId: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'proc:exit'; jobId: string; result: ProcResult }
  | { kind: 'tray:click' }
  | { kind: 'window:maximized'; value: boolean }

export type ShellEventListener = (event: ShellEvent) => void

/** preload 挂到 window.airship 上的全部东西。
 *
 * 所有涉及权限的方法都以 app 打头：主进程据此查能力表并做路径授权。
 * 应用侧不用自己传——壳给每个应用注入一份已绑定的 api（见 shell/useAppApi.ts），
 * 写起来就是 api.fs.read(path)。
 */
export interface AirshipBridge {
  paths(app: AppId): Promise<AppPaths>

  settings: {
    get<T>(scope: SettingsScope, key: string, fallback: T): Promise<T>
    set<T>(scope: SettingsScope, key: string, value: T): Promise<void>
    /** 一次拿全，避免逐键往返 */
    dump(scope: SettingsScope): Promise<Record<string, unknown>>
  }

  dialog: {
    openFiles(app: AppId, options?: OpenFilesOptions): Promise<string[] | null>
    openDirectory(app: AppId, options?: { title?: string }): Promise<string | null>
    saveFile(app: AppId, options?: SaveFileOptions): Promise<string | null>
  }

  fs: {
    read(app: AppId, path: string): Promise<Uint8Array>
    /** 范围读：EPUB/MOBI 的 zip 随机访问走这里，避免整本搬进内存 */
    readRange(app: AppId, path: string, start: number, length: number): Promise<Uint8Array>
    write(app: AppId, path: string, data: Uint8Array | string): Promise<void>
    stat(app: AppId, path: string): Promise<FileStat | null>
    list(app: AppId, dir: string): Promise<DirEntry[]>
    ensureDir(app: AppId, dir: string): Promise<void>
    remove(app: AppId, path: string): Promise<void>
    copy(app: AppId, src: string, dest: string): Promise<void>
    /** 把路径解析到应用数据目录下，返回绝对路径；越界直接抛错 */
    resolveInData(app: AppId, ...segments: string[]): Promise<string>
    /**
     * 把路径解析到壳级共享命名空间下。
     * 应用必须在 manifest 里声明了该命名空间，否则主进程拒绝。
     */
    resolveInShared(app: AppId, ns: SharedNamespace, ...segments: string[]): Promise<string>
  }

  proc: {
    /** 一次性跑完拿结果（探测类短命令） */
    run(app: AppId, request: Omit<ProcRequest, 'jobId'>): Promise<ProcResult>
    /** 后台跑，进度通过 proc:chunk / proc:exit 事件回流 */
    start(app: AppId, request: ProcRequest): Promise<void>
    kill(app: AppId, jobId: string): Promise<boolean>
    list(app: AppId): Promise<string[]>
  }

  tray: {
    set(app: AppId, state: TrayState): Promise<void>
    clear(app: AppId): Promise<void>
  }

  notify: { show(app: AppId, options: NotifyOptions): Promise<void> }

  clipboard: { writeText(text: string): Promise<void>; readText(): Promise<string> }

  log: {
    info(app: AppId, message: string, detail?: unknown): Promise<void>
    warn(app: AppId, message: string, detail?: unknown): Promise<void>
    error(app: AppId, message: string, detail?: unknown): Promise<void>
  }

  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
  }

  /** 订阅壳事件，返回退订函数 */
  on(listener: ShellEventListener): () => void
}

declare global {
  interface Window {
    airship: AirshipBridge
  }
}
