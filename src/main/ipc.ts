import {
  app,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type BrowserWindow,
  type WebContents
} from 'electron'
import {
  copyFileSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  APP_IDS,
  type AppId,
  type Capability,
  type SharedNamespace,
  type ShellEvent
} from '../shared/protocol'
import { APP_MAP, canAccessShared, hasCapability } from '../shared/registry'
import {
  appCacheDir,
  appDataDir,
  paths,
  resolveInData,
  resolveInShared,
  sharedDirsFor
} from './services/paths'
import { settings } from './services/settings'
import { grants } from './services/grants'
import { log } from './services/logging'
import { proc, setProcEmitter } from './services/proc'
import { trayService } from './services/tray'
import { ffmpegPath, setFfmpegPath } from './services/tools'
import type {
  DirEntry,
  FileStat,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  SaveFileOptions,
  TrayState
} from '../shared/protocol'

/**
 * IPC 注册。所有渲染进程能碰到的东西都在这里，一处收口。
 *
 * 每个 handler 的第一步是 assertCap()：应用在自己的 manifest 里声明了什么，
 * 就只放行什么。声明之外的调用不是静默失败，是抛带原因的错，方便应用侧看见。
 */

const APP_SET = new Set<string>(APP_IDS)

function assertApp(value: unknown): AppId {
  if (typeof value !== 'string' || !APP_SET.has(value)) {
    throw new Error(`未知的应用 id：${String(value)}`)
  }
  return value as AppId
}

function assertCap(app: AppId, cap: Capability): void {
  if (!hasCapability(app, cap)) {
    log.warn(app, '能力未声明，已拒绝', { capability: cap })
    throw new Error(`${app} 没有声明 ${cap} 能力（见 src/shared/registry.ts）`)
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

export function registerIpc(
  getWindow: () => BrowserWindow | null,
  options: { shotMode?: boolean } = {}
): void {
  const send = (event: ShellEvent): void => {
    const wc: WebContents | undefined = getWindow()?.webContents
    if (wc && !wc.isDestroyed()) wc.send('airship:event', event)
  }
  setProcEmitter(send)

  const handle = (channel: string, fn: (...args: unknown[]) => unknown | Promise<unknown>): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) }
      } catch (err) {
        // 统一包一层，渲染侧拿到的是可读的中文原因，而不是 "Error invoking remote method"
        const message = err instanceof Error ? err.message : String(err)
        log.error('shell', `${channel} 失败`, { message })
        return { ok: false, error: message }
      }
    })
  }

  /* ---------- 壳级 ---------- */

  handle('shell:paths', (appArg: unknown) => {
    const id = assertApp(appArg)
    const p = paths()
    const meta = APP_MAP[id]
    return {
      data: appDataDir(id),
      cache: appCacheDir(id),
      root: p.root,
      shared: sharedDirsFor(meta?.sharedNamespaces ?? []),
      platform: process.platform,
      shellVersion: app.getVersion()
    }
  })

  handle('shell:ffmpegPath', () => ffmpegPath())

  handle('shell:setFfmpegPath', (exe: unknown) =>
    setFfmpegPath(assertNonEmptyString(exe, 'ffmpeg 路径'))
  )

  handle('shell:openExternal', (url: unknown) => {
    const target = assertNonEmptyString(url, 'url')
    // 只放行 http/https，file:// 和自定义协议一律不开
    if (!/^https?:\/\//i.test(target)) throw new Error(`只允许打开 http/https 链接：${target}`)
    return shell.openExternal(target)
  })

  handle('shell:grants', (app: unknown) => grants.stats(assertApp(app)))

  /* ---------- 设置 ---------- */

  /** 设置作用域：应用 id 或 'shell'。'shell' 不做能力校验，那是壳自己的界面在用。 */
  const assertScope = (value: unknown): AppId | 'shell' => {
    if (value === 'shell') return 'shell'
    return assertApp(value)
  }

  handle('settings:get', (scope: unknown, key: unknown, fallback: unknown) => {
    const id = assertScope(scope)
    if (id !== 'shell') assertCap(id, 'settings')
    return settings.get(id, assertNonEmptyString(key, 'key'), fallback)
  })

  handle('settings:set', (scope: unknown, key: unknown, value: unknown) => {
    const id = assertScope(scope)
    if (id !== 'shell') assertCap(id, 'settings')
    settings.set(id, assertNonEmptyString(key, 'key'), value)
  })

  handle('settings:dump', (scope: unknown) => {
    const id = assertScope(scope)
    if (id !== 'shell') assertCap(id, 'settings')
    return settings.dump(id)
  })

  /* ---------- 对话框 ---------- */

  handle('dialog:openFiles', async (app: unknown, options: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'dialog')
    const win = getWindow()
    const opts = (options ?? {}) as OpenFilesOptions
    const result = await dialog.showOpenDialog(win!, {
      title: opts.title ?? '选择文件',
      filters: opts.filters,
      properties: opts.multiple === false ? ['openFile'] : ['openFile', 'multiSelections']
    })
    if (result.canceled) return null
    // 用户显式选中的，进本应用的可读集合
    for (const p of result.filePaths) {
      grants.grantRead(id, p)
      if (opts.grantParentDir) grants.grantRead(id, dirname(p))
    }
    return result.filePaths
  })

  handle('dialog:openDirectory', async (app: unknown, options: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'dialog')
    const win = getWindow()
    const opts = (options ?? {}) as { title?: string }
    const result = await dialog.showOpenDialog(win!, {
      title: opts.title ?? '选择文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled) return null
    const picked = result.filePaths[0]
    if (picked) grants.grantRead(id, picked)
    return picked ?? null
  })

  handle('dialog:saveFile', async (app: unknown, options: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'dialog')
    const win = getWindow()
    const opts = (options ?? {}) as SaveFileOptions
    const result = await dialog.showSaveDialog(win!, {
      title: opts.title ?? '保存到',
      defaultPath: opts.defaultPath,
      filters: opts.filters
    })
    if (result.canceled) return null
    const target = result.filePath
    if (target) {
      grants.grantWrite(id, target)
      // 输出目录也要能读，否则 ffmpeg 写完无法回读校验
      grants.grantRead(id, dirname(target))
    }
    return target ?? null
  })

  /* ---------- 文件 ---------- */

  handle('fs:read', async (app: unknown, path: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.read')
    const p = assertNonEmptyString(path, 'path')
    grants.assertRead(id, p)
    return readFile(p)
  })

  handle('fs:readRange', async (app: unknown, path: unknown, start: unknown, length: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.read')
    const p = assertNonEmptyString(path, 'path')
    grants.assertRead(id, p)

    const offset = Number(start)
    const size = Number(length)
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`start 必须是非负整数，收到 ${start}`)
    if (!Number.isInteger(size) || size < 0) throw new Error(`length 必须是非负整数，收到 ${length}`)

    const buf = Buffer.alloc(size)
    const fd = openSync(p, 'r')
    try {
      const total = statSync(p).size
      const readable = Math.max(0, Math.min(size, total - offset))
      if (readable === 0) return new Uint8Array(0)
      let done = 0
      while (done < readable) {
        const n = readSync(fd, buf, done, readable - done, offset + done)
        if (n <= 0) break
        done += n
      }
      return new Uint8Array(buf.subarray(0, done))
    } finally {
      closeSync(fd)
    }
  })

  handle('fs:write', (app: unknown, path: unknown, data: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.write')
    const p = assertNonEmptyString(path, 'path')
    grants.assertWrite(id, p)
    mkdirSync(dirname(p), { recursive: true })

    if (typeof data === 'string') {
      writeFileSync(p, data, 'utf8')
    } else if (data instanceof Uint8Array) {
      writeFileSync(p, Buffer.from(data))
    } else if (Buffer.isBuffer(data)) {
      writeFileSync(p, data)
    } else {
      throw new Error(`不支持的写入数据类型：${typeof data}`)
    }
  })

  handle('fs:stat', (app: unknown, path: unknown): FileStat | null => {
    const id = assertApp(app)
    assertCap(id, 'fs.read')
    const p = assertNonEmptyString(path, 'path')
    grants.assertRead(id, p)
    try {
      const s = statSync(p)
      return { size: s.size, isDirectory: s.isDirectory(), mtimeMs: s.mtimeMs }
    } catch {
      return null
    }
  })

  handle('fs:list', (app: unknown, dir: unknown): DirEntry[] => {
    const id = assertApp(app)
    assertCap(id, 'fs.read')
    const d = assertNonEmptyString(dir, 'dir')
    grants.assertRead(id, d)
    const out: DirEntry[] = []
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      let isDirectory = false
      let size = 0
      try {
        const s = statSync(full)
        isDirectory = s.isDirectory()
        size = s.size
      } catch {
        /* 读不了的条目跳过，不让整个列表失败 */
      }
      out.push({ name, path: full, isDirectory, size })
    }
    return out
  })

  handle('fs:ensureDir', (app: unknown, dir: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.write')
    const d = assertNonEmptyString(dir, 'dir')
    grants.assertWrite(id, d)
    mkdirSync(d, { recursive: true })
  })

  handle('fs:remove', (app: unknown, path: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.write')
    const p = assertNonEmptyString(path, 'path')
    grants.assertWrite(id, p)
    rmSync(p, { recursive: true, force: true })
  })

  handle('fs:copy', (app: unknown, src: unknown, dest: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'fs.read')
    assertCap(id, 'fs.write')
    const s = assertNonEmptyString(src, 'src')
    const d = assertNonEmptyString(dest, 'dest')
    grants.assertRead(id, s)
    grants.assertWrite(id, d)
    mkdirSync(dirname(d), { recursive: true })
    copyFileSync(s, d)
  })

  handle('fs:resolveInData', (app: unknown, segments: unknown) => {
    const id = assertApp(app)
    if (!Array.isArray(segments)) throw new Error('segments 必须是数组')
    return resolveInData(
      id,
      segments.map((s) => assertNonEmptyString(s, 'segment'))
    )
  })

  handle('fs:resolveInShared', (app: unknown, ns: unknown, segments: unknown) => {
    const id = assertApp(app)
    const namespace = assertNonEmptyString(ns, 'ns')
    if (!canAccessShared(id, namespace)) {
      log.warn(id, '拒绝访问未声明的共享命名空间', { ns: namespace })
      throw new Error(`${id} 没有声明共享命名空间 ${namespace}（见 src/shared/registry.ts）`)
    }
    if (!Array.isArray(segments)) throw new Error('segments 必须是数组')
    return resolveInShared(
      namespace as SharedNamespace,
      segments.map((s) => assertNonEmptyString(s, 'segment'))
    )
  })

  /* ---------- 子进程 ---------- */

  handle('proc:run', async (app: unknown, request: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'proc')
    const req = request as Omit<ProcRequest, 'jobId'>
    if (!req || !Array.isArray(req.args)) throw new Error('request.args 必须是数组')
    assertNonEmptyString(req.exe, 'request.exe')
    return proc.run(id, req)
  })

  handle('proc:start', (app: unknown, request: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'proc')
    const req = request as ProcRequest
    if (!req || !Array.isArray(req.args)) throw new Error('request.args 必须是数组')
    assertNonEmptyString(req.exe, 'request.exe')
    assertNonEmptyString(req.jobId, 'request.jobId')
    proc.start(id, req)
  })

  handle('proc:kill', (app: unknown, jobId: unknown) =>
    proc.kill(assertNonEmptyString(jobId, 'jobId'), assertApp(app))
  )

  handle('proc:list', (app: unknown) => proc.list(assertApp(app)))

  /* ---------- 托盘 ---------- */

  handle('tray:set', (app: unknown, state: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'tray')
    const s = state as TrayState
    if (!s || typeof s.tooltip !== 'string') throw new Error('state.tooltip 必须是字符串')
    trayService.set(s, () => {
      const win = getWindow()
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    })
  })

  handle('tray:clear', (app: unknown) => {
    assertCap(assertApp(app), 'tray')
    trayService.clear()
  })

  /* ---------- 通知 / 剪贴板 ---------- */

  handle('notify:show', async (app: unknown, options: unknown) => {
    const id = assertApp(app)
    assertCap(id, 'notify')
    const o = options as NotifyOptions
    if (!o || typeof o.title !== 'string') throw new Error('options.title 必须是字符串')
    if (!Notification.isSupported()) return
    new Notification({ title: o.title, body: o.body ?? '', silent: o.silent ?? false }).show()
  })

  handle('clipboard:writeText', (app: unknown, text: unknown) => {
    assertCap(assertApp(app), 'clipboard')
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
  })

  handle('clipboard:readText', (app: unknown) => {
    assertCap(assertApp(app), 'clipboard')
    return clipboard.readText()
  })

  /* ---------- 日志 ---------- */

  for (const level of ['info', 'warn', 'error'] as const) {
    handle(`log:${level}`, (app: unknown, message: unknown, detail: unknown) => {
      const id = assertApp(app)
      assertCap(id, 'log')
      log[level](id, typeof message === 'string' ? message : String(message), detail)
    })
  }

  /* ---------- 窗口 ---------- */

  handle('window:minimize', () => getWindow()?.minimize())

  handle('window:toggleMaximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  handle('window:close', () => getWindow()?.close())

  handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  /* ---------- 截图模式专用：测试钩子 ----------
   *
   * 只在 AIRSHIP_SHOT 下注册。正常启动时这两个频道不存在，
   * 渲染侧调了会直接拿到"没有这个 handler"的错，不会静默放行。
   * 用途：自动化验证时把真实文件授权给应用并让它自动导入打开，
   * 好让截图证明的是"真书真的渲染出来了"，而不是空书架。
   */
  if (options.shotMode) {
    handle('shot:grant', (app: unknown, path: unknown) => {
      const id = assertApp(app)
      grants.grantRead(id, assertNonEmptyString(path, 'path'))
    })

    ipcMain.on('shot:dbg', (_e, message: unknown) => {
      log.info('shell', `dbg: ${String(message)}`)
    })
  }
}
