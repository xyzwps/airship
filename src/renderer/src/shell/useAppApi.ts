import { useMemo } from 'react'
import type {
  AppId,
  AppPaths,
  DirEntry,
  FileStat,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  ProcResult,
  SaveFileOptions,
  SharedNamespace,
  ShellEventListener,
  TrayState
} from '@shared/protocol'

/**
 * 已绑定应用身份的 API。
 *
 * 应用代码里写 api.fs.read(path)，不用每处都带自己的 id。
 * 绑定发生在壳这一侧（useAppApi），主进程仍然按 id 查能力表——
 * 所以这不是"少传一个参数"的语法糖，是身份由壳注入、应用改不了。
 */
export interface AppApi {
  readonly id: AppId
  paths(): Promise<AppPaths>
  settings: {
    get<T>(key: string, fallback: T): Promise<T>
    set<T>(key: string, value: T): Promise<void>
    dump(): Promise<Record<string, unknown>>
  }
  dialog: {
    openFiles(options?: OpenFilesOptions): Promise<string[] | null>
    openDirectory(options?: { title?: string }): Promise<string | null>
    saveFile(options?: SaveFileOptions): Promise<string | null>
  }
  fs: {
    read(path: string): Promise<Uint8Array>
    readRange(path: string, start: number, length: number): Promise<Uint8Array>
    write(path: string, data: Uint8Array | string): Promise<void>
    stat(path: string): Promise<FileStat | null>
    list(dir: string): Promise<DirEntry[]>
    ensureDir(dir: string): Promise<void>
    remove(path: string): Promise<void>
    copy(src: string, dest: string): Promise<void>
    resolveInData(...segments: string[]): Promise<string>
    resolveInShared(ns: SharedNamespace, ...segments: string[]): Promise<string>
  }
  proc: {
    run(request: Omit<ProcRequest, 'jobId'>): Promise<ProcResult>
    start(request: ProcRequest): Promise<void>
    kill(jobId: string): Promise<boolean>
    list(): Promise<string[]>
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
  window: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
    isMaximized(): Promise<boolean>
  }
  on(listener: ShellEventListener): () => void
}

export function useAppApi(app: AppId): AppApi {
  return useMemo(() => bindApi(app), [app])
}

export function bindApi(app: AppId): AppApi {
  const b = window.airship
  return {
    id: app,
    paths: () => b.paths(app),
    settings: {
      get: (key, fallback) => b.settings.get(app, key, fallback),
      set: (key, value) => b.settings.set(app, key, value),
      dump: () => b.settings.dump(app)
    },
    dialog: {
      openFiles: (options) => b.dialog.openFiles(app, options),
      openDirectory: (options) => b.dialog.openDirectory(app, options),
      saveFile: (options) => b.dialog.saveFile(app, options)
    },
    fs: {
      read: (path) => b.fs.read(app, path),
      readRange: (path, start, length) => b.fs.readRange(app, path, start, length),
      write: (path, data) => b.fs.write(app, path, data),
      stat: (path) => b.fs.stat(app, path),
      list: (dir) => b.fs.list(app, dir),
      ensureDir: (dir) => b.fs.ensureDir(app, dir),
      remove: (path) => b.fs.remove(app, path),
      copy: (src, dest) => b.fs.copy(app, src, dest),
      resolveInData: (...segments) => b.fs.resolveInData(app, ...segments),
      resolveInShared: (ns, ...segments) => b.fs.resolveInShared(app, ns, ...segments)
    },
    proc: {
      run: (request) => b.proc.run(app, request),
      start: (request) => b.proc.start(app, request),
      kill: (jobId) => b.proc.kill(app, jobId),
      list: () => b.proc.list(app)
    },
    tray: {
      set: (state) => b.tray.set(app, state),
      clear: () => b.tray.clear(app)
    },
    notify: { show: (options) => b.notify.show(app, options) },
    clipboard: {
      writeText: (text) => b.clipboard.writeText(text),
      readText: () => b.clipboard.readText()
    },
    log: {
      info: (message, detail) => b.log.info(app, message, detail),
      warn: (message, detail) => b.log.warn(app, message, detail),
      error: (message, detail) => b.log.error(app, message, detail)
    },
    window: {
      minimize: () => b.window.minimize(),
      toggleMaximize: () => b.window.toggleMaximize(),
      close: () => b.window.close(),
      isMaximized: () => b.window.isMaximized()
    },
    on: (listener) => b.on(listener)
  }
}
