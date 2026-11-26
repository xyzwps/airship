import type { AppMeta } from './app.ts'

/**
 * runtime 与应用之间的能力契约。
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
 * 值来自各应用自己的清单（`apps/<id>/app.ts`），由 runtime 在运行期注册命令行指来的包时读到。
 * 这里刻意**不**维护一份 id 名单——那样每加一个应用就得回来改契约文件，
 * 违反不变量 I-5（加应用不改 runtime 侧任何文件）。
 *
 * 代价是 TS 不再穷举 id，改成运行时校验（主进程 `appRegistry.isKnownApp`）。
 * 可以接受：应用代码从不传自己的 id，id 由 runtime 绑定注入（见 preload）。
 */
export type AppId = string

/**
 * 设置作用域：应用各自的命名空间，一个应用一份。
 * runtime 自己不持有设置屏：主题这类窗口观感也落在应用自己那份设置文件里
 * （由 theme:set 这条窗口面通道写，不占应用的 settings 能力）。
 */
export type SettingsScope = AppId

/**
 * runtime 托管的共享命名空间登记表。
 *
 * 与应用 id 不同，这份名单**属于 runtime**：目录由 runtime 创建、由 runtime 托管，
 * 新增一个共享数据区是 runtime 的功能变更，不是应用变更。
 * 应用只能在清单里声明自己要访问哪个，声明了不存在的直接拒。
 *
 * 为什么需要它：从前墨读与 PDF 是两个独立应用入口，
 * 书架、导入记录、封面、阅读进度必须是同一套数据——各自存一份就会出现
 * "同一本书在两个入口里各有一本"的重复（PDF 已于 2026-11-26 退场，机制留着）。
 */
export const SHARED_NAMESPACES = ['library'] as const
export type SharedNamespace = (typeof SHARED_NAMESPACES)[number]

/**
 * 运行平台。用界面语言里的名字，不把 `win32` 这种 Node 的实现细节写进清单。
 * 对应关系由 `platformIdOf` 一处给出，主进程与测试替身都问它。
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
 * runtime 认识的外部工具登记表。
 *
 * 与共享命名空间同理，这份名单**属于 runtime**：怎么发现、拿什么标志校验它是真的，
 * 是 runtime 的能力，不是应用的说法。应用只能在清单里声明"我要用哪一个"，
 * 声明了 runtime 不认识的、或没声明就想用的，一律拒（措辞见 shared/errors.ts）。
 *
 * proc 白名单的来历因此只有一个：runtime 按这张表发现的（含环境变量显式指的那一档）。
 */
export const TOOL_NAMES = ['ffmpeg', 'wslc'] as const
export type ToolName = (typeof TOOL_NAMES)[number]


/** 应用能力位。应用在自己的 manifest 里声明，runtime 按声明放行。 */
export type Capability =
  /** 读文件：限应用数据目录内，或本次会话中用户通过系统对话框显式选中的路径 */
  | 'fs.read'
  /** 写文件：限应用数据目录内 */
  | 'fs.write'
  /** 弹系统文件/目录选择框（选中结果自动进入本应用的可读路径集合） */
  | 'dialog'
  /** 读写本应用命名空间下的设置项 */
  | 'settings'
  /** 访问 runtime 级共享命名空间（见 SHARED_NAMESPACES），具体哪几个由 manifest 声明 */
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

/**
 * 能力位的界面说法。首次直跑一个陌生包时要把它念给人听——capabilities 是授权面，
 * 而直跑让"用户自己决定给谁授权"第一次成为必须：不念清单就开窗口等于绕过授权面。
 * 应用安装器的安装页念的也是这一份。措辞只这一处，界面上不许再抄一遍。
 */
export const CAPABILITY_LABEL: Record<Capability, string> = {
  'fs.read': '读你的文件',
  'fs.write': '写你的文件',
  dialog: '弹系统选择框',
  settings: '存自己的设置',
  shared: '碰共享数据区',
  proc: '跑外部程序',
  tray: '占托盘',
  notify: '发系统通知',
  clipboard: '读写剪贴板',
  log: '写日志'
}

/**
 * 后台程序的界面说法。它**不是能力位**：自带一段 Node 代码是包形状读出来的事实
 * （归档根有没有 `backend.js`，见 packageRules.ts 的 PACKAGE_BACKEND_ENTRY），
 * 不是向宿主求的授权。念白与能力清单同一条线，措辞只这一处。
 */
export const BACKEND_PHRASE = '跑它自带的后台程序'

/** 能力清单的人话摘要：空清单念不碰你的文件，而不是念一个空字符串 */
export function capabilitiesPhrase(list: readonly Capability[], hasBackend = false): string {
  const parts: string[] = []
  if (list.length > 0) parts.push(list.map((c) => CAPABILITY_LABEL[c]).join('、'))
  if (hasBackend) parts.push(BACKEND_PHRASE)
  if (parts.length === 0) return '不碰你的文件'
  return parts.join('、')
}

export interface AppPaths {
  /** 本应用私有数据目录，读写默认落在这里 */
  data: string
  /** 本应用缓存目录，可随时整体删除重建 */
  cache: string
  /** airship 的家目录（`~/.airship`）：这一族的数据、共享区、日志都在它下面 */
  root: string
  /** 本应用有权访问的共享命名空间根目录 */
  shared: Partial<Record<SharedNamespace, string>>
  /** 平台标识，值同 process.platform */
  platform: string
  /** runtime 版本 */
  runtimeVersion: string
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
  /** 可执行文件路径，必须是 runtime 允许的（见 main/services/proc.ts 的白名单规则） */
  exe: string
  args: string[]
  cwd?: string
  /** 交给 runtime 的标识，事件回流时原样带回 */
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
   * 只给 badge 时 runtime 仅更新提示文字，图标保持默认——
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

/** 主题快照：mode 是用户选的档，resolved 是实际生效的亮/暗 */
export interface ThemeSnapshot {
  mode: 'light' | 'dark' | 'system'
  resolved: 'light' | 'dark'
}

/** runtime → 渲染进程的事件频道：只投给归属那个窗口，没有全局广播 */
export type ShellEvent =
  | { kind: 'proc:chunk'; jobId: string; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'proc:exit'; jobId: string; result: ProcResult }
  | { kind: 'tray:click' }
  | { kind: 'window:maximized'; value: boolean }
  | { kind: 'backend:event'; method: string; payload?: unknown }
  /**
   * 应用自带的后台进程没了（崩的，或被 runtime 收掉的）。
   * 在途的 backend:invoke 会各自收到拒绝那句；但"事件任务"型调用（提交后靠
   * backend:event 收进度的那种）没有回话可等——这个事件就是让它们就地失败的信号。
   */
  | { kind: 'backend:exited' }

export type ShellEventListener = (event: ShellEvent) => void

/**
 * 拖放/选择事件里浏览器交出来的那一颗文件——契约只认换路径用得上的那几个字段。
 *
 * 真身是 DOM 的 `File`（形状比这个宽）；契约层不引整棵 DOM 类型树，与它不引 Electron 同一个道理。
 */
export interface DroppedFile {
  readonly name: string
  readonly size: number
}

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

  /** 读本应用的主题档。每个应用各记各的，落在它自己那份设置文件里 */
  theme(): Promise<ThemeSnapshot>
  /**
   * 改本应用的主题档并立刻生效。mode 是 'system' 时，实际亮暗由渲染侧用 matchMedia
   * 算好传进来——主进程没有 matchMedia，不该去猜。
   * 这是窗口观感的一部分（与最小化/关闭同族），不占应用的 settings 能力。
   */
  setTheme(mode: ThemeSnapshot['mode'], resolvedHint?: 'light' | 'dark'): Promise<ThemeSnapshot>

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
     * 把路径解析到 runtime 级共享命名空间下。
     * 应用必须在自己的清单里声明了该命名空间，否则主进程拒绝。
     */
    resolveInShared(ns: SharedNamespace, ...segments: string[]): Promise<string>
    /**
     * 拖放/选择事件里那个 File 对象对应的本机路径；换不出路径（JS 自造、没盘上真身）就是空字符串。
     *
     * 整件事留在渲染进程内：preload 用 Electron 的 `webUtils.getPathForFile` 就地算，
     * 不过桥、不占 fs 能力位——它只是"读出浏览器已经给你的那个对象的名字"，
     * 能不能读那份文件仍由 fs.read / fs.write 的闸门说了算。
     */
    pathForFile(file: DroppedFile): string
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
   * runtime 已发现的外部工具。要 proc 能力，**并且**要在自己的清单 `tools` 里声明过这一个。
   * 应用既不能自己找一个来跑，也不能借 runtime 发现的名义跑没声明的工具。
   */
  tools: { path(name: ToolName): Promise<string | null> }

  /**
   * 应用自带的后台程序（包根那份 `backend.js`，runtime 为它单独起进程）。
   * 不要能力位：包里有那个条目就有它——约定，不是授权。invoke 是一次请求-回话；
   * 后台主动推的事件走 on() 收 `backend:event`。
   * 后台没起来时 invoke 会先把它拉起来；它崩了不影响窗口，下一次 invoke 再拉一个新的。
   * 包里没有 `backend.js` 时 invoke 拒，并念出这条约定。
   */
  backend: {
    invoke<T>(method: string, payload?: unknown): Promise<T>
  }

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

  /** 订阅 runtime 事件（只收本窗口该收到的），返回退订函数 */
  on(listener: ShellEventListener): () => void
}

/**
 * 应用拿到的 API：契约 + 自己的 id。
 *
 * 放在契约层而不是 runtime 的 UI 层，是因为共享包也要用它——共享包属于依赖图的下层，
 * 反过来依赖 runtime 的界面代码就破了自己定的规则。
 * id 只用于显示与日志，不参与任何权限判定（身份在 preload 与 event.sender 那里）。
 */
export type AppApi = AirshipBridge & { id: AppId }

declare global {
  interface Window {
    airship: AirshipBridge
  }
}