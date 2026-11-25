import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AirshipBridge,
  AppId,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  SaveFileOptions,
  SharedNamespace,
  ShellEvent,
  ShellEventListener,
  TrayState,
  ToolName
} from '@airship/contract'

/**
 * preload —— runtime 暴露给渲染进程的唯一入口。
 *
 * 规则：
 *   1. 只暴露协议里声明过的东西，ipcRenderer 本身绝不外泄。
 *   2. **身份由启动参数注入**：应用窗口的 preload 拿到 `--airship-app=<id>`，
 *      调用时自动填上；应用侧根本没有"传 id"这个动作，也就没法冒充别的应用。
 *      主进程还会用 event.sender 反查归属做二次确认。
 *   3. 只有这一套面：runtime 自己没有窗口，不存在第二套"启动器面"。
 *   4. 主进程统一返回 { ok, value } / { ok, error }，这里拆包：
 *      成功返回值，失败抛 Error(中文原因)。
 *   5. 事件只走一个频道 airship:event，按 kind 分发给本窗口的订阅者。
 *
 * sandbox: true，所以这里不能 require node 模块，只能用 electron 的渲染侧 API。
 */

interface Envelope<T> {
  ok: boolean
  value?: T
  error?: string
}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!res || res.ok !== true) {
    throw new Error(res?.error ?? `${channel} 调用失败（主进程没有返回结果）`)
  }
  return res.value as T
}

/** 从启动参数取本窗口绑定的应用 id；runtime 开的每个窗口都有这一个 */
function boundApp(): AppId | null {
  const hit = process.argv.find((a) => a.startsWith('--airship-app='))
  return hit ? hit.slice('--airship-app='.length) : null
}

const APP = boundApp()

/** 应用侧调用一律用绑定身份填空，调用方看不到这个参数 */
function needApp(): AppId {
  if (!APP) throw new Error('这个窗口没有绑定应用身份：preload 只该由 runtime 的应用窗口加载')
  return APP
}

const listeners = new Set<ShellEventListener>()

ipcRenderer.on('airship:event', (_e, event: ShellEvent) => {
  for (const fn of [...listeners]) {
    try {
      fn(event)
    } catch (err) {
      // 一个监听器抛错不该影响其他监听器
      console.error('[airship] 事件监听器异常', err)
    }
  }
})

const bridge: AirshipBridge = {
  paths: () => call('runtime:paths', needApp()),

  theme: () => call('theme:get'),

  setTheme: (mode, resolvedHint) => call('theme:set', mode, resolvedHint),

  settings: {
    get: <T>(key: string, fallback: T) => call<T>('settings:get', needApp(), key, fallback),
    set: <T>(key: string, value: T) => call<void>('settings:set', needApp(), key, value),
    dump: () => call<Record<string, unknown>>('settings:dump', needApp())
  },

  dialog: {
    openFiles: (options?: OpenFilesOptions) => call<string[] | null>('dialog:openFiles', needApp(), options ?? {}),
    openDirectory: (options?: { title?: string }) =>
      call<string | null>('dialog:openDirectory', needApp(), options ?? {}),
    saveFile: (options?: SaveFileOptions) => call<string | null>('dialog:saveFile', needApp(), options ?? {})
  },

  fs: {
    read: (path: string) => call<Uint8Array>('fs:read', needApp(), path),
    readRange: (path: string, start: number, length: number) =>
      call<Uint8Array>('fs:readRange', needApp(), path, start, length),
    write: (path: string, data: Uint8Array | string) => call<void>('fs:write', needApp(), path, data),
    stat: (path: string) =>
      call<{ size: number; isDirectory: boolean; mtimeMs: number } | null>('fs:stat', needApp(), path),
    list: (dir: string) =>
      call<{ name: string; path: string; isDirectory: boolean; size: number }[]>('fs:list', needApp(), dir),
    ensureDir: (dir: string) => call<void>('fs:ensureDir', needApp(), dir),
    remove: (path: string) => call<void>('fs:remove', needApp(), path),
    copy: (src: string, dest: string) => call<void>('fs:copy', needApp(), src, dest),
    resolveInData: (...segments: string[]) => call<string>('fs:resolveInData', needApp(), segments),
    resolveInShared: (ns: SharedNamespace, ...segments: string[]) =>
      call<string>('fs:resolveInShared', needApp(), ns, segments),
    // 就地算，不过桥：webUtils 是 Electron 给 sandbox 渲染侧的 API（contextBridge 函数收 File 原对象，见官方用法）
    pathForFile: (file: File) => webUtils.getPathForFile(file)
  },

  proc: {
    run: (request: Omit<ProcRequest, 'jobId'>) =>
      call<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
        'proc:run',
        needApp(),
        request
      ),
    start: (request: ProcRequest) => call<void>('proc:start', needApp(), request),
    kill: (jobId: string) => call<boolean>('proc:kill', needApp(), jobId),
    list: () => call<string[]>('proc:list', needApp())
  },

  tools: {
    path: (name: ToolName) => call<string | null>('tools:path', needApp(), name)
  },

  backend: {
    invoke: <T>(method: string, payload?: unknown) => call<T>('backend:invoke', needApp(), method, payload)
  },

  tray: {
    set: (state: TrayState) => call<void>('tray:set', needApp(), state),
    clear: () => call<void>('tray:clear', needApp())
  },

  notify: {
    show: (options: NotifyOptions) => call<void>('notify:show', needApp(), options)
  },

  clipboard: {
    writeText: (text: string) => call<void>('clipboard:writeText', needApp(), text),
    readText: () => call<string>('clipboard:readText', needApp())
  },

  log: {
    info: (message: string, detail?: unknown) => call<void>('log:info', needApp(), message, detail),
    warn: (message: string, detail?: unknown) => call<void>('log:warn', needApp(), message, detail),
    error: (message: string, detail?: unknown) => call<void>('log:error', needApp(), message, detail)
  },

  window: {
    minimize: () => call<void>('window:minimize'),
    toggleMaximize: () => call<void>('window:toggleMaximize'),
    close: () => call<void>('window:close'),
    isMaximized: () => call<boolean>('window:isMaximized'),
    setTitle: (title: string | null) => call<void>('window:setTitle', title)
  },

  on: (listener: ShellEventListener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

/** 应用窗口只拿到 airship（已绑定身份）；没有第二套面 */
contextBridge.exposeInMainWorld('airship', bridge)

/* ---------------- 截图模式钩子 ----------------
 *
 * 只在 AIRSHIP_SHOT 下存在，正常启动时这些频道根本没有。
 * 单窗口逐个切应用的旧做法已经废了：现在是多窗口，
 * 主进程开一个窗口、等它报就绪、capturePage、关掉，再下一个。
 */
const shotMode = process.argv.includes('--shot') || Boolean(process.env.AIRSHIP_SHOT)
if (shotMode) {
  contextBridge.exposeInMainWorld('__airshipShot', {
    ready: () => ipcRenderer.send('shot:ready'),
    onAutotest: (cb: (payload: { app: string; path: string }) => void) => {
      const handler = (_e: unknown, payload: { app: string; path: string }): void => cb(payload)
      ipcRenderer.on('shot:autotest', handler)
      return () => ipcRenderer.removeListener('shot:autotest', handler)
    },
    /** 测试钩子：把真实文件授权给本应用读 */
    grantRead: (app: string, path: string) => ipcRenderer.invoke('shot:grant', app, path),
    /** 应用注册完 autotest 监听后报就绪，主进程等这个才推事件 */
    listenerReady: (app: string) => ipcRenderer.send('shot:listener', app),
    /** 性能标记：主进程按窗口归属换算成"从窗口打开起"的相对毫秒 */
    mark: (name: string) => ipcRenderer.send('shot:mark', name)
  })
}
