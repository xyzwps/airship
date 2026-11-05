import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { registerIpc } from './ipc'
import { settings } from './services/settings'
import { log } from './services/logging'
import { proc } from './services/proc'
import { trayService } from './services/tray'
import { ffmpegPath } from './services/tools'
import { APPS } from '../shared/registry'

/**
 * 飞船主进程。
 *
 * 正常启动：单窗口 + 无边框自绘标题栏，界面在 out/renderer。
 * 截图模式（AIRSHIP_SHOT=1 --shot）：逐个应用加载、等渲染进程报就绪、
 * capturePage 存 PNG、然后退出。这是"真的跑起来看到了"的证据，
 * 比"构建成功"有用。
 */

const SHOT_MODE = process.env.AIRSHIP_SHOT === '1' && process.argv.includes('--shot')

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

let win: BrowserWindow | null = null

function getWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

function loadWindowState(): WindowState {
  return settings.get<WindowState>(
    'shell',
    'window',
    { width: 1180, height: 760, maximized: false }
  )
}

function saveWindowState(): void {
  const w = getWindow()
  if (!w) return
  const maximized = w.isMaximized()
  // 最大化时不要把最大化后的尺寸记下来，否则还原后窗口尺寸不对
  const bounds = maximized ? (settings.get<WindowState>('shell', 'window', loadWindowState())) : w.getBounds()
  settings.set<WindowState>('shell', 'window', {
    width: bounds.width,
    height: bounds.height,
    x: maximized ? bounds.x : w.getBounds().x,
    y: maximized ? bounds.y : w.getBounds().y,
    maximized
  })
}

function createWindow(): BrowserWindow {
  const state = loadWindowState()

  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#1b1d23',
    icon: join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => {
    if (!SHOT_MODE) window.show()
  })

  window.on('maximize', () => broadcast({ kind: 'window:maximized', value: true }))
  window.on('unmaximize', () => broadcast({ kind: 'window:maximized', value: false }))
  window.on('close', saveWindowState)
  window.on('closed', () => {
    if (win === window) win = null
  })

  // 外部链接交给系统浏览器，不在应用里开新窗口
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void import('electron').then(({ shell }) => shell.openExternal(url))
    return { action: 'deny' }
  })

  // 只转发带标记的调试输出，避免刷屏
  window.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[airship-dbg]')) log.info('shell', message)
  })

  if (state.maximized && !SHOT_MODE) window.maximize()

  return window
}

function broadcast(event: { kind: string; [key: string]: unknown }): void {
  const wc: WebContents | undefined = getWindow()?.webContents
  if (wc && !wc.isDestroyed()) wc.send('airship:event', event)
}

async function loadRenderer(window: BrowserWindow): Promise<void> {
  const url = process.env.ELECTRON_RENDERER_URL
  if (url) {
    await window.loadURL(url)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/* ---------------- 截图模式 ---------------- */

async function runShotMode(): Promise<void> {
  const outDir = join(process.cwd(), 'shots')
  mkdirSync(outDir, { recursive: true })

  // 单窗口逐个切应用，不重载：file:// 下反复 loadFile 带 fragment 会 ERR_FAILED
  const window = createWindow()
  win = window

  let readyCount = 0
  ipcMain.on('shot:ready', () => {
    readyCount++
  })

  const waitForReady = async (n: number): Promise<void> => {
    while (readyCount < n) await new Promise((r) => setTimeout(r, 50))
  }

  // lazy chunk 加载完、组件挂载并注册监听后才报这个；ready 只代表壳切过去了
  const listenersReady = new Set<string>()
  const listenerWaiters: (() => void)[] = []
  ipcMain.on('shot:listener', (_e, app: unknown) => {
    listenersReady.add(String(app))
    for (const w of listenerWaiters.splice(0)) w()
  })
  const waitForListener = async (app: string): Promise<void> => {
    while (!listenersReady.has(app)) {
      await new Promise<void>((resolve) => listenerWaiters.push(resolve))
    }
  }

  await loadRenderer(window)
  window.show()

  // 自动化验证：AIRSHIP_AUTOTEST='{"app":"books","path":"C:\\...epub"}'
  // 让目标应用自动导入并打开真实文件，截图才有说服力
  let autotest: { app: string; path: string } | null = null
  const rawAutotest = process.env.AIRSHIP_AUTOTEST
  if (rawAutotest) {
    try {
      autotest = JSON.parse(rawAutotest) as { app: string; path: string }
    } catch {
      console.warn('[shot] AIRSHIP_AUTOTEST 不是合法 JSON，忽略')
    }
  }

  const targets: (string | null)[] = [null, ...APPS.map((a) => a.id)]
  const names = ['shell-home', ...APPS.map((a) => a.id)]

  for (let i = 0; i < targets.length; i++) {
    const name = names[i]!
    const expected = i + 1 // 第 i 次切换后的第 i+1 个 ready

    window.webContents.send('shot:goto', targets[i])

    const isAutotestTarget = autotest !== null && targets[i] === autotest.app
    if (isAutotestTarget && autotest) {
      const at = autotest
      // 等应用挂载并注册完监听再推；ready 只代表壳切过去了，lazy chunk 可能还在加载
      await waitForListener(at.app)
      log.info('shell', '发送 shot:autotest', at)
      window.webContents.send('shot:autotest', at)
      // 导入 + 解析 + 首屏渲染比空界面慢得多，给足时间
      await new Promise((r) => setTimeout(r, 9000))
    } else {
      await waitForReady(expected)
      // 等 lazy chunk 加载和字体落定，否则截到 spinner 或半渲染
      await new Promise((r) => setTimeout(r, 1200))
    }

    const image = await window.webContents.capturePage()
    const file = join(outDir, `${name}${isAutotestTarget ? '-autotest' : ''}.png`)
    writeFileSync(file, image.toPNG())
    console.log(`[shot] ${file}  ${image.getSize().width}x${image.getSize().height}`)
  }

  app.quit()
}

/* ---------------- 正常启动 ---------------- */

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.xyzwp.airship')

  log.info('shell', '启动', {
    version: app.getVersion(),
    shotMode: SHOT_MODE,
    platform: process.platform,
    userData: app.getPath('userData')
  })

  registerIpc(getWindow, { shotMode: SHOT_MODE })

  // 提前发现 ffmpeg，界面第一帧就能显示"可用/不可用"，不用等用户点进去
  const ffmpeg = ffmpegPath()
  log.info('shell', 'ffmpeg 探测结果', { path: ffmpeg })

  if (SHOT_MODE) {
    await runShotMode()
    return
  }

  win = createWindow()
  await loadRenderer(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      win = createWindow()
      void loadRenderer(win)
    }
  })
})

// 单实例：第二次启动把已有窗口唤到前台
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = getWindow()
    if (!w) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
}

app.on('window-all-closed', () => {
  proc.killAll()
  trayService.clear()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  proc.killAll()
  trayService.clear()
})

process.on('uncaughtException', (err) => {
  log.error('shell', '主进程未捕获异常', { error: String(err), stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log.error('shell', '未处理的 Promise 拒绝', { reason: String(reason) })
})
