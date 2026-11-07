import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { packageFor, unavailableReason } from './services/appRegistry'
import { platformIdOf } from '@airship/contract'
import { notRegistered, platformUnsupported } from '@airship/contract'
import { targetsFor, type WindowRef } from './services/routing'
import { WindowLedger, appUserModelIdFor, defaultSizeFor } from './services/windowLedger'
import { log } from './services/logging'
import { proc } from './services/proc'
import { trayService } from './services/tray'
import type { ShellEvent, ThemeSnapshot } from '@airship/contract'

/**
 * 窗口管理：一个启动器窗口 + 每个应用一个独立窗口。
 *
 * 这是能力边界从"设计"变"强制"的地方：
 *   1. 每个应用窗口是独立渲染进程，一个崩了不影响别人；
 *   2. 窗口的 preload 被注入 `--airship-app=<id>`，应用侧拿到的 bridge 身份是壳给的，改不了；
 *   3. 主进程按 `event.sender` 反查归属，传上来的 id 与归属不符就拒——
 *      所以 A 应用既收不到 B 应用的事件，也冒充不了 B 应用。
 *
 * "哪个应用现在有活窗口"这件事由 services/windowLedger.ts 那份纯逻辑管，
 * 这里只负责把它接到 BrowserWindow 上。
 *
 * 应用窗口加载的是**那个包自己的入口文档**（`airship://<id>/index.html`），
 * 不再是壳里的一个 html：壳的产物里没有任何应用代码，窗口之间只剩这条 preload 接缝。
 */

export type Owner = string | 'shell'

const LAUNCHER_SIZE = { width: 1000, height: 680 }
const APP_SIZE = { width: 1100, height: 740 }

let launcher: BrowserWindow | null = null
const appWindows = new Map<string, BrowserWindow>()

/** 归属 ↔ webContents.id 的台账，主进程所有权限判定都从这里出发 */
const ledger = new WindowLedger()

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function baseWebPreferences(owner: Owner): Electron.WebPreferences {
  return {
    preload: preloadPath(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    additionalArguments: owner === 'shell' ? ['--airship-role=shell'] : [`--airship-app=${owner}`]
  }
}

export function ownerOfContents(webContentsId: number): Owner | null {
  return ledger.ownerOf(webContentsId)
}

/** 当前平台名，清单的 platforms 就按它判定 */
export function currentPlatform(): ReturnType<typeof platformIdOf> {
  return platformIdOf(process.platform)
}

/** 壳自己的渲染产物住在 out/renderer/shell/ 下（launcher 一份，没有别的） */
const RENDERER_ENTRY_DIR = 'shell'

function loadLauncher(window: BrowserWindow): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(`${devUrl}/${RENDERER_ENTRY_DIR}/launcher.html`)
    return
  }
  void window.loadFile(join(__dirname, `../renderer/${RENDERER_ENTRY_DIR}/launcher.html`))
}

/**
 * 应用窗口加载的是包自己的入口文档。
 *
 * dev 与产包只在这一处不同：dev 走 vite dev server（源码那一份，热更才有效），
 * 产包走 `airship://<id>/<entry>`（那一份在包根，由 `packageProtocol.ts` 供）。
 * preload 注入的身份两边完全一样——`--airship-app=<id>` 跟文档来源无关。
 */
function loadPackageEntry(window: BrowserWindow, id: string, entryUrl: string): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const target = devUrl ? `${devUrl}/apps/${id}/index.html` : entryUrl
  void window.loadURL(target)
}

function wireWindow(window: BrowserWindow, owner: Owner, title: string): void {
  // closed 事件里 window.webContents 已经销毁，摸它会抛 "Object has been destroyed"，
  // 所以先把 id 记下来
  const contentsId = window.webContents.id
  ledger.open(owner, contentsId)
  window.setTitle(title)

  window.once('ready-to-show', () => window.show())
  window.on('maximize', () => sendTo(owner, { kind: 'window:maximized', value: true }))
  window.on('unmaximize', () => sendTo(owner, { kind: 'window:maximized', value: false }))
  window.on('closed', () => {
    ledger.close(contentsId)
    if (owner !== 'shell') {
      appWindows.delete(owner)
      // 应用窗口没了，它名下的摊子要收干净：还在跑的转码/容器命令、它占着的托盘
      proc.killApp(owner)
      trayService.clear(owner)
    }
    if (window === launcher) launcher = null
  })

  // 外部链接交系统浏览器；file:// 与自定义协议不开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  // 只转发带标记的调试输出，避免刷屏
  window.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[airship-dbg]')) log.info(String(owner), message)
  })

  /**
   * 截图模式把渲染侧的声音全记下：加载中卡住时，唯一看得见的线索就在这边。
   * 正常启动不挂这些监听——渲染侧的 console 不该往壳的日志里灌。
   */
  if (process.env.AIRSHIP_SHOT === '1') {
    const tag = String(owner)
    window.webContents.on('console-message', (_e, level, message, line, source) => {
      log.warn(tag, `渲染侧 console（档 ${level}）：${message} @ ${source}:${line}`)
    })
    window.webContents.on('did-fail-load', (_e, code, description, validatedUrl, isMainFrame) => {
      log.error(tag, `加载失败 ${code} ${description}：${validatedUrl}（主框架 ${isMainFrame}）`)
    })
  }
}

export function createLauncher(): BrowserWindow {
  if (launcher && !launcher.isDestroyed()) {
    launcher.show()
    launcher.focus()
    return launcher
  }

  const window = new BrowserWindow({
    ...LAUNCHER_SIZE,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1b1d23',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: baseWebPreferences('shell')
  })

  launcher = window
  wireWindow(window, 'shell', '飞船')
  loadLauncher(window)
  return window
}

/** 打开（或聚焦）某应用的独立窗口 */
export function openAppWindow(appId: string): BrowserWindow {
  const pkg = packageFor(appId)
  if (!pkg) throw new Error(notRegistered(appId))
  const meta = pkg.meta

  // 清单里声明了只跑在某些平台的应用，在这台机器上根本不开窗口
  const blocked = unavailableReason(appId, currentPlatform())
  if (blocked) throw new Error(platformUnsupported(meta.name, blocked))

  if (ledger.decision(appId) === 'focus') {
    const existing = appWindows.get(appId)
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
      return existing
    }
  }

  // 尺寸只认清单（没写就跟壳的默认），位置不记：每次由系统摆
  const size = defaultSizeFor(meta, APP_SIZE)
  const window = new BrowserWindow({
    ...size,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1b1d23',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: baseWebPreferences(appId)
  })

  // 独立任务栏条目：能单独固定、单独预览，看起来就是个独立应用。
  // Windows 专有、且不在 BrowserWindow 的类型定义里，所以按可选方法调用。
  const withModelId = window as unknown as { setAppUserModelId?: (id: string) => void }
  withModelId.setAppUserModelId?.(appUserModelIdFor(appId))

  appWindows.set(appId, window)
  wireWindow(window, appId, meta.name)
  loadPackageEntry(window, appId, pkg.entryUrl)
  log.info(appId, '应用窗口已打开')
  return window
}

export function openAppIds(): string[] {
  return ledger.openAppIds()
}

export function windowFor(owner: Owner): BrowserWindow | null {
  if (owner === 'shell') return launcher && !launcher.isDestroyed() ? launcher : null
  const w = appWindows.get(owner)
  return w && !w.isDestroyed() ? w : null
}

interface LiveWindow extends WindowRef {
  window: BrowserWindow
}

/** 当前活着的窗口，带归属 */
function liveWindows(): LiveWindow[] {
  const out: LiveWindow[] = []
  if (launcher && !launcher.isDestroyed()) {
    out.push({ contentsId: launcher.webContents.id, owner: 'shell', window: launcher })
  }
  for (const [id, window] of appWindows) {
    if (!window.isDestroyed()) out.push({ contentsId: window.webContents.id, owner: id, window })
  }
  return out
}

/**
 * 发给归属窗口。路由规则走 services/routing.ts 的纯函数——
 * 那样这条规则才真的被测到，而不是测一段没人调用的代码。
 * 应用没开（没有归属窗口）时事件被丢弃，不广播。
 */
export function sendTo(owner: Owner, event: ShellEvent): void {
  const list = liveWindows()
  const targets = new Set(targetsFor(String(owner), list))
  for (const w of list) {
    if (targets.has(w.contentsId)) w.window.webContents.send('airship:event', event)
  }
}

/** 广播给所有窗口：主题变更这类壳级事件 */
export function broadcast(event: ShellEvent): void {
  for (const w of liveWindows()) w.window.webContents.send('airship:event', event)
}

export function bringLauncherToFront(): void {
  if (!launcher || launcher.isDestroyed()) return
  if (launcher.isMinimized()) launcher.restore()
  launcher.show()
  launcher.focus()
}

export function closeAllWindows(): void {
  for (const window of appWindows.values()) if (!window.isDestroyed()) window.close()
  if (launcher && !launcher.isDestroyed()) launcher.close()
}

export function allWindowCount(): number {
  return (launcher && !launcher.isDestroyed() ? 1 : 0) + openAppIds().length
}

/** 每个窗口的内存，诊断与性能实测用 */
export function windowMetrics(): { label: string; workingSetKB: number }[] {
  const metrics = app.getAppMetrics()
  const out: { label: string; workingSetKB: number }[] = []

  const push = (label: string, pid: number): void => {
    const found = metrics.find((m) => m.pid === pid)
    if (found) out.push({ label, workingSetKB: found.memory.workingSetSize })
  }

  if (launcher && !launcher.isDestroyed()) push('启动器', launcher.webContents.getOSProcessId())
  for (const [id, window] of appWindows) {
    if (!window.isDestroyed()) push(packageFor(id)?.meta.name ?? id, window.webContents.getOSProcessId())
  }
  return out
}

export function isRegistered(appId: string): boolean {
  return packageFor(appId) !== null
}

export function themeSnapshotCache(): ThemeSnapshot | null {
  return cachedTheme
}

let cachedTheme: ThemeSnapshot | null = null

export function setCachedTheme(snapshot: ThemeSnapshot): void {
  cachedTheme = snapshot
}
