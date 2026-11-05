import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { APP_MAP } from './services/appRegistry'
import { targetsFor, type WindowRef } from './services/routing'
import { settings } from './services/settings'
import { log } from './services/logging'
import type { ShellEvent, ThemeSnapshot } from '@shared/protocol'

/**
 * 窗口管理：一个启动器窗口 + 每个应用一个独立窗口。
 *
 * 这是能力边界从"设计"变"强制"的地方：
 *   1. 每个应用窗口是独立渲染进程，一个崩了不影响别人；
 *   2. 窗口的 preload 被注入 `--airship-app=<id>`，应用侧拿到的 bridge 身份是壳给的，改不了；
 *   3. 主进程按 `event.sender` 反查归属，传上来的 id 与归属不符就拒——
 *      所以 A 应用既收不到 B 应用的事件，也冒充不了 B 应用。
 */

export type Owner = string | 'shell'

const LAUNCHER_SIZE = { width: 1000, height: 680 }
const APP_SIZE = { width: 1100, height: 740 }

let launcher: BrowserWindow | null = null
const appWindows = new Map<string, BrowserWindow>()

/** webContents → 归属，主进程所有权限判定都从这里出发。
 *  用普通 Map 而不是 WeakMap：键是 webContents.id（数字），窗口 closed 时显式删掉。 */
const owners = new Map<number, Owner>()

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
  return owners.get(webContentsId) ?? null
}

/** 渲染根是 src/，两个 html 在 shell/ 下，产物也带这一层目录 */
const RENDERER_ENTRY_DIR = 'shell'

function loadEntry(window: BrowserWindow, entry: 'launcher' | 'app', query?: Record<string, string>): void {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const search = query ? `?${new URLSearchParams(query).toString()}` : ''
  if (devUrl) {
    void window.loadURL(`${devUrl}/${RENDERER_ENTRY_DIR}/${entry}.html${search}`)
    return
  }
  void window.loadFile(join(__dirname, `../renderer/${RENDERER_ENTRY_DIR}/${entry}.html`), {
    search: search.replace(/^\?/, '')
  })
}

function boundsFor(key: string, fallback: { width: number; height: number }): {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
} {
  return settings.get('shell', key, { ...fallback, maximized: false })
}

function persistBounds(key: string, window: BrowserWindow): void {
  if (window.isDestroyed()) return
  const maximized = window.isMaximized()
  const b = window.getBounds()
  settings.set('shell', key, { width: b.width, height: b.height, x: b.x, y: b.y, maximized })
}

function wireWindow(
  window: BrowserWindow,
  owner: Owner,
  boundsKey: string,
  title: string,
  saved: { maximized: boolean }
): void {
  // closed 事件里 window.webContents 已经销毁，摸它会抛 "Object has been destroyed"，
  // 所以先把 id 记下来
  const contentsId = window.webContents.id
  owners.set(contentsId, owner)
  window.setTitle(title)

  window.once('ready-to-show', () => window.show())
  window.on('maximize', () => sendTo(owner, { kind: 'window:maximized', value: true }))
  window.on('unmaximize', () => sendTo(owner, { kind: 'window:maximized', value: false }))
  window.on('close', () => persistBounds(boundsKey, window))
  window.on('closed', () => {
    owners.delete(contentsId)
    if (owner !== 'shell') appWindows.delete(owner)
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

  if (saved.maximized) window.maximize()
}

export function createLauncher(): BrowserWindow {
  if (launcher && !launcher.isDestroyed()) {
    launcher.show()
    launcher.focus()
    return launcher
  }

  const saved = boundsFor('launcherWindow', LAUNCHER_SIZE)
  const window = new BrowserWindow({
    ...saved,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1b1d23',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: baseWebPreferences('shell')
  })

  launcher = window
  wireWindow(window, 'shell', 'launcherWindow', '飞船', saved)
  loadEntry(window, 'launcher')
  return window
}

/** 打开（或聚焦）某应用的独立窗口 */
export function openAppWindow(appId: string): BrowserWindow {
  const existing = appWindows.get(appId)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return existing
  }

  const meta = APP_MAP.get(appId)
  if (!meta) throw new Error(`没有注册这个应用：${appId}`)

  const saved = boundsFor(`appWindow:${appId}`, APP_SIZE)
  const window = new BrowserWindow({
    ...saved,
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
  withModelId.setAppUserModelId?.(`dev.xyzwp.airship.${appId}`)

  appWindows.set(appId, window)
  wireWindow(window, appId, `appWindow:${appId}`, meta.name, saved)
  loadEntry(window, 'app', { app: appId })
  log.info(appId, '应用窗口已打开')
  return window
}

export function openAppIds(): string[] {
  return [...appWindows.keys()].filter((id) => {
    const w = appWindows.get(id)
    return w && !w.isDestroyed()
  })
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
    if (!window.isDestroyed()) push(APP_MAP.get(id)?.name ?? id, window.webContents.getOSProcessId())
  }
  return out
}

export function isRegistered(appId: string): boolean {
  return APP_MAP.has(appId)
}

export function themeSnapshotCache(): ThemeSnapshot | null {
  return cachedTheme
}

let cachedTheme: ThemeSnapshot | null = null

export function setCachedTheme(snapshot: ThemeSnapshot): void {
  cachedTheme = snapshot
}
