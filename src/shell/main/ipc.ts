import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Notification,
  shell,
  type IpcMainInvokeEvent
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
  type AppId,
  type Capability,
  type SharedNamespace,
  type ThemeSnapshot
} from '@shared/protocol'
import { canAccessShared, hasCapability, isKnownApp, sharedNamespacesOf } from './services/appRegistry'
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
import { proc } from './services/proc'
import { trayService } from './services/tray'
import { ffmpegPath, setFfmpegPath } from './services/tools'
import {
  bringLauncherToFront,
  broadcast,
  isRegistered,
  openAppIds,
  openAppWindow,
  ownerOfContents,
  setCachedTheme,
  themeSnapshotCache,
  windowMetrics
} from './windows'
import type {
  DirEntry,
  FileStat,
  NotifyOptions,
  OpenFilesOptions,
  ProcRequest,
  SaveFileOptions,
  TrayState
} from '@shared/protocol'

/**
 * IPC 注册。渲染进程能碰到的东西都在这里，一处收口。
 *
 * 两道闸，缺一不可：
 *   1. `assertSender` —— 从 event.sender 反查这个窗口归属哪个应用。查不到就是野窗口，拒。
 *   2. `assertApp`    —— 调用方传来的 app 必须等于归属。**身份由 preload 注入，
 *      应用改不了；就算改了，这里也对不上。**
 *   3. `assertCap`    —— 归属应用必须在自己的清单里声明过这个能力。
 *
 * 顺序是刻意的：先确认"你是谁"，再确认"你能不能"。
 */

function senderOwner(event: IpcMainInvokeEvent): string | 'shell' {
  const owner = ownerOfContents(event.sender.id)
  if (!owner) throw new Error('调用来源不是壳注册的窗口，拒绝')
  return owner
}

/** 应用侧调用：归属必须是某个已注册应用 */
function assertApp(event: IpcMainInvokeEvent, appArg: unknown): AppId {
  const owner = senderOwner(event)
  if (owner === 'shell') throw new Error('这个接口只给应用用，启动器不该调')
  if (appArg !== owner) {
    log.error(owner, '身份不匹配，已拒绝', { claimed: String(appArg) })
    throw new Error(`身份不匹配：这个窗口属于 ${owner}，不能以 ${String(appArg)} 的名义调用`)
  }
  if (!isKnownApp(appArg)) throw new Error(`未知的应用 id：${appArg}`)
  return appArg
}

function assertCap(app: AppId, cap: Capability): void {
  if (!hasCapability(app, cap)) {
    log.warn(app, '能力未声明，已拒绝', { capability: cap })
    throw new Error(`${app} 没有声明 ${cap} 能力（要用它就在 apps/${app}/app.ts 的 capabilities 里声明）`)
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} 必须是非空字符串，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function ownWindow(event: IpcMainInvokeEvent): BrowserWindow | null {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && !win.isDestroyed() ? win : null
}

export function readTheme(): ThemeSnapshot {
  const stored = settings.get<{ mode?: ThemeSnapshot['mode'] }>('shell', 'theme', {})
  const mode = stored.mode ?? 'system'
  return { mode, resolved: resolveMode(mode) }
}

function resolveMode(mode: ThemeSnapshot['mode']): 'light' | 'dark' {
  if (mode !== 'system') return mode
  // 主进程没有 matchMedia，用 Windows 注册表那套太脆；交给渲染侧算，
  // 这里只在需要给新窗口初值时兜底为亮色，渲染侧首帧会用自己的 matchMedia 纠正
  return settings.get<'light' | 'dark'>('shell', 'lastResolved', 'light')
}

export function registerIpc(options: { shotMode?: boolean } = {}): void {
  const handle = (
    channel: string,
    fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, value: await fn(event, ...args) }
      } catch (err) {
        // 统一包一层，渲染侧拿到的是可读的中文原因，而不是 "Error invoking remote method"
        const message = err instanceof Error ? err.message : String(err)
        log.error('shell', `${channel} 失败`, { message })
        return { ok: false, error: message }
      }
    })
  }

  /* ---------- 应用侧：身份与路径 ---------- */

  handle('shell:paths', (event, appArg: unknown) => {
    const id = assertApp(event, appArg)
    const p = paths()
    const namespaces = sharedNamespacesOf(id)
    return {
      data: appDataDir(id),
      cache: appCacheDir(id),
      root: p.root,
      shared: sharedDirsFor(namespaces),
      platform: process.platform,
      shellVersion: app.getVersion()
    }
  })

  handle('theme:get', (event) => {
    // 启动器和应用窗口都能读
    senderOwner(event)
    return themeSnapshotCache() ?? readTheme()
  })

  /* ---------- 设置 ---------- */

  handle('settings:get', (event, scope: unknown, key: unknown, fallback: unknown) => {
    const id = scopeOf(event, scope)
    if (id !== 'shell') assertCap(id, 'settings')
    return settings.get(id, assertNonEmptyString(key, 'key'), fallback)
  })

  handle('settings:set', (event, scope: unknown, key: unknown, value: unknown) => {
    const id = scopeOf(event, scope)
    if (id !== 'shell') assertCap(id, 'settings')
    settings.set(id, assertNonEmptyString(key, 'key'), value)
  })

  handle('settings:dump', (event, scope: unknown) => {
    const id = scopeOf(event, scope)
    if (id !== 'shell') assertCap(id, 'settings')
    return settings.dump(id)
  })

  /* ---------- 对话框 ---------- */

  handle('dialog:openFiles', async (event, appArg: unknown, options: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'dialog')
    const win = ownWindow(event)
    const opts = (options ?? {}) as OpenFilesOptions
    const result = await dialog.showOpenDialog(win!, {
      title: opts.title ?? '选择文件',
      filters: opts.filters,
      properties: opts.multiple === false ? ['openFile'] : ['openFile', 'multiSelections']
    })
    if (result.canceled) return null
    for (const p of result.filePaths) {
      grants.grantRead(id, p)
      if (opts.grantParentDir) grants.grantRead(id, dirname(p))
    }
    return result.filePaths
  })

  handle('dialog:openDirectory', async (event, appArg: unknown, options: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'dialog')
    const win = ownWindow(event)
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

  handle('dialog:saveFile', async (event, appArg: unknown, options: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'dialog')
    const win = ownWindow(event)
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

  handle('fs:read', async (event, appArg: unknown, path: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'fs.read')
    const p = assertNonEmptyString(path, 'path')
    grants.assertRead(id, p)
    return readFile(p)
  })

  handle('fs:readRange', async (event, appArg: unknown, path: unknown, start: unknown, length: unknown) => {
    const id = assertApp(event, appArg)
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

  handle('fs:write', (event, appArg: unknown, path: unknown, data: unknown) => {
    const id = assertApp(event, appArg)
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

  handle('fs:stat', (event, appArg: unknown, path: unknown): FileStat | null => {
    const id = assertApp(event, appArg)
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

  handle('fs:list', (event, appArg: unknown, dir: unknown): DirEntry[] => {
    const id = assertApp(event, appArg)
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

  handle('fs:ensureDir', (event, appArg: unknown, dir: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'fs.write')
    const d = assertNonEmptyString(dir, 'dir')
    grants.assertWrite(id, d)
    mkdirSync(d, { recursive: true })
  })

  handle('fs:remove', (event, appArg: unknown, path: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'fs.write')
    const p = assertNonEmptyString(path, 'path')
    grants.assertWrite(id, p)
    rmSync(p, { recursive: true, force: true })
  })

  handle('fs:copy', (event, appArg: unknown, src: unknown, dest: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'fs.read')
    assertCap(id, 'fs.write')
    const s = assertNonEmptyString(src, 'src')
    const d = assertNonEmptyString(dest, 'dest')
    grants.assertRead(id, s)
    grants.assertWrite(id, d)
    mkdirSync(dirname(d), { recursive: true })
    copyFileSync(s, d)
  })

  handle('fs:resolveInData', (event, appArg: unknown, segments: unknown) => {
    const id = assertApp(event, appArg)
    if (!Array.isArray(segments)) throw new Error('segments 必须是数组')
    return resolveInData(
      id,
      segments.map((s) => assertNonEmptyString(s, 'segment'))
    )
  })

  handle('fs:resolveInShared', (event, appArg: unknown, ns: unknown, segments: unknown) => {
    const id = assertApp(event, appArg)
    const namespace = assertNonEmptyString(ns, 'ns')
    if (!canAccessShared(id, namespace)) {
      log.warn(id, '拒绝访问未声明的共享命名空间', { ns: namespace })
      throw new Error(`${id} 没有声明共享命名空间 ${namespace}（在 apps/${id}/app.ts 的 sharedNamespaces 里声明）`)
    }
    if (!Array.isArray(segments)) throw new Error('segments 必须是数组')
    return resolveInShared(
      namespace as SharedNamespace,
      segments.map((s) => assertNonEmptyString(s, 'segment'))
    )
  })

  /* ---------- 子进程：事件只回归属窗口 ---------- */

  handle('proc:run', async (event, appArg: unknown, request: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'proc')
    const req = request as Omit<ProcRequest, 'jobId'>
    if (!req || !Array.isArray(req.args)) throw new Error('request.args 必须是数组')
    assertNonEmptyString(req.exe, 'request.exe')
    return proc.run(id, req)
  })

  handle('proc:start', (event, appArg: unknown, request: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'proc')
    const req = request as ProcRequest
    if (!req || !Array.isArray(req.args)) throw new Error('request.args 必须是数组')
    assertNonEmptyString(req.exe, 'request.exe')
    assertNonEmptyString(req.jobId, 'request.jobId')
    proc.start(id, req)
  })

  handle('proc:kill', (event, appArg: unknown, jobId: unknown) =>
    proc.kill(assertNonEmptyString(jobId, 'jobId'), assertApp(event, appArg))
  )

  handle('proc:list', (event, appArg: unknown) => proc.list(assertApp(event, appArg)))

  handle('tools:ffmpegPath', (event, appArg: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'proc')
    return ffmpegPath()
  })

  /* ---------- 托盘 ---------- */

  handle('tray:set', (event, appArg: unknown, state: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'tray')
    const s = state as TrayState
    if (!s || typeof s.tooltip !== 'string') throw new Error('state.tooltip 必须是字符串')
    trayService.set(id, s, bringLauncherToFront)

    // 截图模式下把托盘图标落盘：capturePage 截不到系统托盘，
    // 不然"图标真的画出来了没有"这件事就只能靠相信代码
    if (options.shotMode && s.iconDataUrl) {
      try {
        const base64 = s.iconDataUrl.slice(s.iconDataUrl.indexOf(',') + 1)
        mkdirSync(join(process.cwd(), 'shots'), { recursive: true })
        writeFileSync(join(process.cwd(), 'shots', `tray-${id}.png`), Buffer.from(base64, 'base64'))
      } catch {
        /* 存不下不影响功能 */
      }
    }
  })

  handle('tray:clear', (event, appArg: unknown) => {
    trayService.clear(assertApp(event, appArg))
  })

  /* ---------- 通知 / 剪贴板 ---------- */

  handle('notify:show', (event, appArg: unknown, options: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'notify')
    const o = options as NotifyOptions
    if (!o || typeof o.title !== 'string') throw new Error('options.title 必须是字符串')
    if (!Notification.isSupported()) return
    new Notification({ title: o.title, body: o.body ?? '', silent: o.silent ?? false }).show()
  })

  handle('clipboard:writeText', (event, appArg: unknown, text: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'clipboard')
    clipboard.writeText(typeof text === 'string' ? text : String(text ?? ''))
  })

  handle('clipboard:readText', (event, appArg: unknown) => {
    const id = assertApp(event, appArg)
    assertCap(id, 'clipboard')
    return clipboard.readText()
  })

  /* ---------- 日志 ---------- */

  for (const level of ['info', 'warn', 'error'] as const) {
    handle(`log:${level}`, (event, appArg: unknown, message: unknown, detail: unknown) => {
      const id = assertApp(event, appArg)
      assertCap(id, 'log')
      log[level](id, typeof message === 'string' ? message : String(message), detail)
    })
  }

  /* ---------- 窗口：作用于发送者自己 ---------- */

  handle('window:minimize', (event) => {
    senderOwner(event)
    ownWindow(event)?.minimize()
  })

  handle('window:toggleMaximize', (event) => {
    senderOwner(event)
    const win = ownWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  handle('window:close', (event) => {
    senderOwner(event)
    ownWindow(event)?.close()
  })

  handle('window:isMaximized', (event) => {
    senderOwner(event)
    return ownWindow(event)?.isMaximized() ?? false
  })

  /* ---------- 启动器专用面 ---------- */


  handle('launcher:openApp', (event, appId: unknown) => {
    requireShell(event)
    const id = assertNonEmptyString(appId, 'appId')
    if (!isRegistered(id)) throw new Error(`没有注册这个应用：${id}`)
    openAppWindow(id)
  })

  handle('launcher:openApps', (event) => {
    requireShell(event)
    return openAppIds()
  })

  handle('launcher:setTheme', (event, mode: unknown, resolvedHint: unknown) => {
    requireShell(event)
    const next = assertNonEmptyString(mode, 'mode') as ThemeSnapshot['mode']
    if (!['light', 'dark', 'system'].includes(next)) throw new Error(`不认识的主题档：${next}`)
    settings.set('shell', 'theme', { mode: next })

    const fallback = themeSnapshotCache()?.resolved ?? 'light'
    const resolved =
      next === 'system'
        ? resolvedHint === 'dark' || resolvedHint === 'light'
          ? resolvedHint
          : settings.get<'light' | 'dark'>('shell', 'lastResolved', fallback)
        : next

    settings.set('shell', 'lastResolved', resolved)
    const snapshot: ThemeSnapshot = { mode: next, resolved }
    setCachedTheme(snapshot)
    broadcast({ kind: 'theme:changed', value: snapshot })
    return snapshot
  })

  handle('launcher:settingsGet', (event, key: unknown, fallback: unknown) => {
    requireShell(event)
    return settings.get('shell', assertNonEmptyString(key, 'key'), fallback)
  })

  handle('launcher:settingsSet', (event, key: unknown, value: unknown) => {
    requireShell(event)
    settings.set('shell', assertNonEmptyString(key, 'key'), value)
  })

  handle('launcher:rootPaths', (event) => {
    requireShell(event)
    const p = paths()
    return {
      data: p.root,
      cache: p.root,
      root: p.root,
      shared: {},
      platform: process.platform,
      shellVersion: app.getVersion()
    }
  })

  handle('launcher:ffmpegPath', (event) => {
    requireShell(event)
    return ffmpegPath()
  })

  handle('launcher:setFfmpegPath', (event, exe: unknown) => {
    requireShell(event)
    return setFfmpegPath(assertNonEmptyString(exe, 'ffmpeg 路径'))
  })

  handle('launcher:grants', (event, appId: unknown) => {
    requireShell(event)
    const id = assertNonEmptyString(appId, 'appId')
    if (!isRegistered(id)) throw new Error(`没有注册这个应用：${id}`)
    return grants.stats(id as AppId)
  })

  handle('launcher:openExternal', (event, url: unknown) => {
    requireShell(event)
    const target = assertNonEmptyString(url, 'url')
    if (!/^https?:\/\//i.test(target)) throw new Error(`只允许打开 http/https 链接：${target}`)
    return shell.openExternal(target)
  })

  handle('launcher:metrics', (event) => {
    requireShell(event)
    return windowMetrics()
  })

  /* ---------- 截图模式专用：测试钩子 ----------
   *
   * 只在 AIRSHIP_SHOT 下注册。正常启动时这两个频道不存在，
   * 渲染侧调了会直接拿到"没有这个 handler"的错，不会静默放行。
   */
  if (options.shotMode) {
    handle('shot:grant', (event, appArg: unknown, path: unknown) => {
      const id = assertApp(event, appArg)
      grants.grantRead(id, assertNonEmptyString(path, 'path'))
    })

    ipcMain.on('shot:dbg', (_e, message: unknown) => {
      log.info('shell', `dbg: ${String(message)}`)
    })
  }
}

/* ================= 辅助 ================= */

function requireShell(event: IpcMainInvokeEvent): void {
  if (senderOwner(event) !== 'shell') throw new Error('这个接口只有启动器能用')
}

function scopeOf(event: IpcMainInvokeEvent, scope: unknown): string | 'shell' {
  const owner = senderOwner(event)
  if (scope === 'shell') {
    if (owner !== 'shell') throw new Error('只有启动器能读写壳级设置')
    return 'shell'
  }
  if (typeof scope !== 'string') throw new Error('设置作用域必须是字符串')
  if (scope !== owner) throw new Error(`身份不匹配：这个窗口属于 ${owner}，不能写 ${scope} 的设置`)
  if (!isKnownApp(scope)) throw new Error(`未知的应用 id：${scope}`)
  return scope
}
