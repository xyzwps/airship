import { contextBridge, ipcRenderer } from 'electron'
import type {
  AirshipBridge,
  AppId,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  SaveFileOptions,
  SettingsScope,
  SharedNamespace,
  ShellEvent,
  ShellEventListener,
  TrayState
} from '../shared/protocol'

/**
 * preload —— 壳暴露给渲染进程的唯一入口。
 *
 * 规则：
 *   1. 只暴露协议里声明过的东西，ipcRenderer 本身绝不外泄。
 *   2. 主进程统一返回 { ok, value } / { ok, error }，这里拆包：
 *      成功返回值，失败抛 Error(中文原因)。应用侧就是普通的 try/catch。
 *   3. 事件只走一个频道 airship:event，按 kind 分发给订阅者。
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

const listeners = new Set<ShellEventListener>()

ipcRenderer.on('airship:event', (_e, event: ShellEvent) => {
  for (const fn of [...listeners]) {
    try {
      fn(event)
    } catch (err) {
      // 一个应用的监听器抛错不该影响其他应用
      console.error('[airship] 事件监听器异常', err)
    }
  }
})

const bridge: AirshipBridge = {
  paths: (app: AppId) => call('shell:paths', app),

  settings: {
    get: <T>(scope: SettingsScope, key: string, fallback: T) =>
      call<T>('settings:get', scope, key, fallback),
    set: <T>(scope: SettingsScope, key: string, value: T) =>
      call<void>('settings:set', scope, key, value),
    dump: (scope: SettingsScope) => call<Record<string, unknown>>('settings:dump', scope)
  },

  dialog: {
    openFiles: (app: AppId, options?: OpenFilesOptions) =>
      call<string[] | null>('dialog:openFiles', app, options ?? {}),
    openDirectory: (app: AppId, options?: { title?: string }) =>
      call<string | null>('dialog:openDirectory', app, options ?? {}),
    saveFile: (app: AppId, options?: SaveFileOptions) =>
      call<string | null>('dialog:saveFile', app, options ?? {})
  },

  fs: {
    read: (app: AppId, path: string) => call<Uint8Array>('fs:read', app, path),
    readRange: (app: AppId, path: string, start: number, length: number) =>
      call<Uint8Array>('fs:readRange', app, path, start, length),
    write: (app: AppId, path: string, data: Uint8Array | string) =>
      call<void>('fs:write', app, path, data),
    stat: (app: AppId, path: string) =>
      call<{ size: number; isDirectory: boolean; mtimeMs: number } | null>('fs:stat', app, path),
    list: (app: AppId, dir: string) =>
      call<{ name: string; path: string; isDirectory: boolean; size: number }[]>('fs:list', app, dir),
    ensureDir: (app: AppId, dir: string) => call<void>('fs:ensureDir', app, dir),
    remove: (app: AppId, path: string) => call<void>('fs:remove', app, path),
    copy: (app: AppId, src: string, dest: string) => call<void>('fs:copy', app, src, dest),
    resolveInData: (app: AppId, ...segments: string[]) =>
      call<string>('fs:resolveInData', app, segments),
    resolveInShared: (app: AppId, ns: SharedNamespace, ...segments: string[]) =>
      call<string>('fs:resolveInShared', app, ns, segments)
  },

  proc: {
    run: (app: AppId, request: Omit<ProcRequest, 'jobId'>) =>
      call<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(
        'proc:run',
        app,
        request
      ),
    start: (app: AppId, request: ProcRequest) => call<void>('proc:start', app, request),
    kill: (app: AppId, jobId: string) => call<boolean>('proc:kill', app, jobId),
    list: (app: AppId) => call<string[]>('proc:list', app)
  },

  tray: {
    set: (app: AppId, state: TrayState) => call<void>('tray:set', app, state),
    clear: (app: AppId) => call<void>('tray:clear', app)
  },

  notify: {
    show: (app: AppId, options: NotifyOptions) => call<void>('notify:show', app, options)
  },

  clipboard: {
    writeText: (text: string) => call<void>('clipboard:writeText', 'shell' as AppId, text),
    readText: () => call<string>('clipboard:readText', 'shell' as AppId)
  },

  log: {
    info: (app: AppId, message: string, detail?: unknown) =>
      call<void>('log:info', app, message, detail),
    warn: (app: AppId, message: string, detail?: unknown) =>
      call<void>('log:warn', app, message, detail),
    error: (app: AppId, message: string, detail?: unknown) =>
      call<void>('log:error', app, message, detail)
  },

  window: {
    minimize: () => call<void>('window:minimize'),
    toggleMaximize: () => call<void>('window:toggleMaximize'),
    close: () => call<void>('window:close'),
    isMaximized: () => call<boolean>('window:isMaximized')
  },

  on: (listener: ShellEventListener) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
}

contextBridge.exposeInMainWorld('airship', bridge)

/** 壳自身的少量控制面：ffmpeg 路径、诊断。应用不通过这里拿能力。 */
contextBridge.exposeInMainWorld('airshipShell', {
  ffmpegPath: () => call<string | null>('shell:ffmpegPath'),
  setFfmpegPath: (exe: string) =>
    call<{ ok: boolean; error?: string }>('shell:setFfmpegPath', exe),
  openExternal: (url: string) => call<void>('shell:openExternal', url),
  grants: (app: AppId) => call<{ read: number; write: number }>('shell:grants', app)
})

// 截图模式：渲染进程挂载完成后告诉主进程可以 capturePage 了。
// 单窗口方案：主进程逐个发 shot:goto，渲染侧切应用、渲染完再报 ready。
// 不用重载窗口带 hash 的方式——file:// 下带 fragment 反复 loadFile 会 ERR_FAILED。
const shotMode = process.argv.includes('--shot') || Boolean(process.env.AIRSHIP_SHOT)
if (shotMode) {
  contextBridge.exposeInMainWorld('__airshipShot', {
    ready: () => ipcRenderer.send('shot:ready'),
    onGoto: (cb: (app: string | null) => void) => {
      const handler = (_e: unknown, app: string | null): void => cb(app)
      ipcRenderer.on('shot:goto', handler)
      return () => ipcRenderer.removeListener('shot:goto', handler)
    },
    onAutotest: (cb: (payload: { app: string; path: string }) => void) => {
      const handler = (_e: unknown, payload: { app: string; path: string }): void => cb(payload)
      ipcRenderer.on('shot:autotest', handler)
      return () => ipcRenderer.removeListener('shot:autotest', handler)
    },
    /** 测试钩子：把真实文件授权给应用读。只在截图模式存在。 */
    grantRead: (app: string, path: string) => ipcRenderer.invoke('shot:grant', app, path),
    /** 应用注册完 autotest 监听后报就绪，主进程等这个再推事件，避免丢给没挂载的组件 */
    listenerReady: (app: string) => ipcRenderer.send('shot:listener', app)
  })
}
