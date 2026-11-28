import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { packageFor, unavailableReason } from './services/appRegistry'
import { platformIdOf } from '@airship/contract'
import { notRegistered, platformUnsupported } from '@airship/contract'
import { targetsFor, type WindowRef } from './services/routing'
import { WindowLedger, defaultSizeFor } from './services/windowLedger'
import { applyTaskbarIdentity, taskbarIdentityFor } from './services/taskbarIdentity'
import { log } from './services/logging'
import { backendHost } from './services/backendHost'
import { trayService } from './services/tray'
import type { ShellEvent } from '@airship/contract'

/**
 * 窗口管理：一个应用一个独立窗口，runtime 自己没有窗口。
 *
 * 这是隔离边界从"设计"变"强制"的地方：
 *   1. 每个应用窗口是独立渲染进程，一个崩了不影响别人；
 *   2. 窗口的 preload 被注入 `--airship-app=<id>`，应用侧拿到的 bridge 身份是 runtime 给的，改不了；
 *   3. 主进程按 `event.sender` 反查归属，传上来的 id 与归属不符就拒——
 *      所以 A 应用既收不到 B 应用的事件，也冒充不了 B 应用。
 *
 * "哪个应用现在有活窗口"这件事由 services/windowLedger.ts 那份纯逻辑管，
 * 这里只负责把它接到 BrowserWindow 上。
 *
 * 应用窗口加载的是**那个包自己的入口文档**（`airship://<id>/index.html`），
 * runtime 的产物里没有任何应用代码，窗口之间只剩这条 preload 接缝。
 */

export type Owner = string

const APP_SIZE = { width: 1100, height: 740 }

const appWindows = new Map<string, BrowserWindow>()

/** 归属 ↔ webContents.id 的台账，主进程所有权限判定都从这里出发 */
const ledger = new WindowLedger()

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function baseWebPreferences(owner: Owner): Electron.WebPreferences {
  /**
   * 每个应用窗口同一套收紧的默认：同源策略不豁免。
   *
   * 从前声明了 `net` 的窗口会换到 `webSecurity: false` 那一档（对象存储的响应没有跨源许可，
   * 渲染侧直连就得豁免，判据见已删除的 BR-011 注记）。`net` 整族退场后没有窗口需要豁免——
   * 要连外部服务的应用把请求交给自带的后台进程（Node 侧，不受同源策略与 CSP 管），
   * 窗口本身只剩包内的东西。
   */
  return {
    preload: preloadPath(),
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    spellcheck: false,
    additionalArguments: [`--airship-app=${owner}`]
  }
}

export function ownerOfContents(webContentsId: number): Owner | null {
  return ledger.ownerOf(webContentsId)
}

/** 当前平台名，清单的 platforms 就按它判定 */
export function currentPlatform(): ReturnType<typeof platformIdOf> {
  return platformIdOf(process.platform)
}

/**
 * 应用窗口加载的是包自己的入口文档。
 *
 * dev 与产包只在这一处不同：dev 时 launcher（仓库里的 just、外部项目的 airship CLI）
 * 把入口文档的完整地址放进 `AIRSHIP_DEV_URL`，窗口直接加载它（源码那一份，热更才有效）；
 * 产包走 `airship://<id>/<entry>`（那一份在包根，由 `packageProtocol.ts` 供）。
 * runtime 不认识任何项目目录形状——拼路径是 launcher 的事。
 * preload 注入的身份两边完全一样——`--airship-app=<id>` 跟文档来源无关。
 */
function loadPackageEntry(window: BrowserWindow, entryUrl: string): void {
  void window.loadURL(process.env.AIRSHIP_DEV_URL ?? entryUrl)
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
    appWindows.delete(owner)
    // 应用窗口没了，它名下的摊子要收干净：它的后端进程、它占着的托盘
    // （后端自己起的程序不归这里管——Windows 上 terminate 带不走孙进程，那份后端负责）
    backendHost.kill(owner)
    trayService.clear(owner)
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
   * 正常启动不挂这些监听——渲染侧的 console 不该往 runtime 的日志里灌。
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

  // 尺寸只认清单（没写就跟 runtime 的默认），位置不记：每次由系统摆
  const size = defaultSizeFor(meta, APP_SIZE)
  // 任务栏身份要在建窗口之前算好：窗口自己那张图标与外壳那颗按钮用的是同一份落盘 ico
  const identity = taskbarIdentityFor(pkg)
  const window = new BrowserWindow({
    ...size,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1b1d23',
    icon: identity.appIconPath ?? join(__dirname, '../../assets/icon.png'),
    webPreferences: baseWebPreferences(appId)
  })

  // 独立任务栏条目：能单独固定、单独预览，看起来就是个独立应用。
  // 身份是**逐窗口**给的——`app.setAppUserModelId()` 只有进程级那一份，八个应用共用一个
  // runtime 进程时它只会给出一个身份（这正是 TD-001 从前假绿的地方：那句是空操作）。
  applyTaskbarIdentity(window, identity)

  appWindows.set(appId, window)
  wireWindow(window, appId, meta.name)
  loadPackageEntry(window, pkg.entryUrl)
  // 包根带 backend.js 的应用：窗口一开就把后端拉起来预热。
  // 判据是包形状，不是清单字段——没这个条目就没有，白起一个进程才是真浪费。
  // 起不来只进日志不开错误弹窗——窗口的第一句错误该由应用自己的界面念。
  if (backendHost.hasBackend(appId)) {
    backendHost.ensure(appId).catch((err: unknown) => {
      log.error(appId, '后端程序预热失败', { message: err instanceof Error ? err.message : String(err) })
    })
  }
  log.info(appId, '应用窗口已打开')
  return window
}

/**
 * 把这个应用的窗口唤到前台（托盘点击、第二实例转发聚焦都用它）。
 * 窗口已经没了就重开一个——台账里还登记着而死引用还在的局面不该把人挡在外面。
 */
export function bringAppToFront(owner: Owner): void {
  const existing = appWindows.get(owner)
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore()
    existing.show()
    existing.focus()
    return
  }
  openAppWindow(owner)
}

export function openAppIds(): string[] {
  return ledger.openAppIds()
}

export function windowFor(owner: Owner): BrowserWindow | null {
  const w = appWindows.get(owner)
  return w && !w.isDestroyed() ? w : null
}

interface LiveWindow extends WindowRef {
  window: BrowserWindow
}

/** 当前活着的窗口，带归属 */
function liveWindows(): LiveWindow[] {
  const out: LiveWindow[] = []
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

export function closeAllWindows(): void {
  for (const window of appWindows.values()) if (!window.isDestroyed()) window.close()
}

export function allWindowCount(): number {
  return openAppIds().length
}

/** 每个窗口的内存，诊断与性能实测用 */
export function windowMetrics(): { label: string; workingSetKB: number }[] {
  const metrics = app.getAppMetrics()
  const out: { label: string; workingSetKB: number }[] = []

  const push = (label: string, pid: number): void => {
    const found = metrics.find((m) => m.pid === pid)
    if (found) out.push({ label, workingSetKB: found.memory.workingSetSize })
  }

  for (const [id, window] of appWindows) {
    if (!window.isDestroyed()) push(packageFor(id)?.meta.name ?? id, window.webContents.getOSProcessId())
  }
  return out
}

export function isRegistered(appId: string): boolean {
  return packageFor(appId) !== null
}