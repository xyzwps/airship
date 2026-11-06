import { app, ipcMain, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc, readTheme } from './ipc'
import { log } from './services/logging'
import { proc, setProcEmitter } from './services/proc'
import { trayService } from './services/tray'
import { toolStatus } from './services/tools'
import { appsAvailableOn } from './services/appRegistry'
import {
  bringLauncherToFront,
  createLauncher,
  currentPlatform,
  openAppWindow,
  ownerOfContents,
  sendTo,
  setCachedTheme,
  windowMetrics
} from './windows'
import type { ThemeSnapshot } from '@shared/protocol'

/**
 * 飞船主进程。
 *
 * 正常启动：一个启动器窗口；点应用开该应用自己的窗口。
 * 截图模式（AIRSHIP_SHOT=1 --shot）：启动器一张、每个应用窗口一张，
 * 都等渲染侧报就绪再 capturePage——"真的跑起来看到了"才算交付。
 */

const SHOT_MODE = process.env.AIRSHIP_SHOT === '1' && process.argv.includes('--shot')

/**
 * 截图模式用独立的 userData，且不参与单实例。
 *
 * 否则你正开着飞船看界面时，我跑一次截图会静默退出（抢不到锁），
 * 还会跟你的实例抢同一份 Chromium 缓存目录、刷一堆"Unable to move the cache"。
 * 验证工装不该踩在正在使用的人身上。
 */
if (SHOT_MODE) {
  app.setPath('userData', join(app.getPath('userData'), '..', 'airship-shot-profile'))
}

/* ---------------- 截图模式 ---------------- */

interface Autotest {
  app: string
  path: string
}

async function runShotMode(): Promise<void> {
  const outDir = join(process.cwd(), 'shots')
  mkdirSync(outDir, { recursive: true })

  const readySenders = new Set<number>()
  ipcMain.on('shot:ready', (e) => readySenders.add(e.sender.id))

  const listenersReady = new Set<string>()
  const listenerWaiters: (() => void)[] = []
  const openedAt = new Map<string, number>()
  const mountMs = new Map<string, number>()
  const marks: { app: string; name: string; ms: number }[] = []

  ipcMain.on('shot:listener', (_e, appArg: unknown) => {
    const id = String(appArg)
    listenersReady.add(id)
    const start = openedAt.get(id)
    if (start) mountMs.set(id, Date.now() - start)
    for (const w of listenerWaiters.splice(0)) w()
  })

  ipcMain.on('shot:mark', (e, name: unknown) => {
    const owner = ownerOfContents(e.sender.id)
    if (!owner || owner === 'shell') return
    const start = openedAt.get(owner) ?? Date.now()
    marks.push({ app: owner, name: String(name), ms: Date.now() - start })
  })

  const waitReady = async (sender: WebContents): Promise<void> => {
    while (!readySenders.has(sender.id)) await sleep(50)
  }
  const waitListener = async (appId: string): Promise<void> => {
    while (!listenersReady.has(appId)) {
      await new Promise<void>((resolve) => listenerWaiters.push(resolve))
    }
  }

  let autotest: Autotest | null = null
  const rawAutotest = process.env.AIRSHIP_AUTOTEST
  if (rawAutotest) {
    try {
      autotest = JSON.parse(rawAutotest) as Autotest
    } catch {
      console.warn('[shot] AIRSHIP_AUTOTEST 不是合法 JSON，忽略')
    }
  }

  const launcher = createLauncher()
  await waitReady(launcher.webContents)
  await sleep(1200)
  await capture(launcher.webContents, join(outDir, 'launcher.png'))
  const metrics: { label: string; workingSetKB: number }[] = [...windowMetrics()]

  for (const meta of appsAvailableOn(currentPlatform())) {
    openedAt.set(meta.id, Date.now())
    const window = openAppWindow(meta.id)
    const isAutotestTarget = autotest !== null && autotest.app === meta.id

    // 就绪信号：该窗口的应用组件 chunk 已 resolve。
    // 不能等"注册了 autotest 监听"——普通应用根本没有那个钩子，会死等。
    await waitReady(window.webContents)

    if (isAutotestTarget && autotest) {
      // 自动导入要往应用里推事件，得等它把监听注册上
      await waitListener(meta.id)
      window.webContents.send('shot:autotest', autotest)
      // 导入 + 解析 + 首屏渲染比空界面慢得多，给足时间
      await sleep(9000)
    } else {
      // 3 秒：容器台第一屏要等一条真 `wslc list`（冷启动实测 2.5s，热了 0.1s），
      // 等 1.5s 截出来永远是"尚未刷新"那张空壳
      await sleep(3000)
    }

    const suffix = isAutotestTarget ? '-autotest' : ''
    await capture(window.webContents, join(outDir, `${meta.id}${suffix}.png`))
    // 趁窗口还开着采样，关掉之后就没有这个数字了
    for (const m of windowMetrics()) {
      if (!metrics.some((x) => x.label === m.label)) metrics.push(m)
    }

    // 关掉，免得下一个应用的内存里混着上一个
    window.close()
    await sleep(300)
  }

  // 顺手把每窗口内存与耗时打出来，性能判据要的是数字不是感觉
  console.log('[metrics]', JSON.stringify(metrics))
  console.log(
    '[perf]',
    JSON.stringify({
      mountMs: Object.fromEntries(mountMs),
      marks
    })
  )
  app.quit()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function capture(sender: WebContents, file: string): Promise<void> {
  const image = await sender.capturePage()
  writeFileSync(file, image.toPNG())
  const size = image.getSize()
  console.log(`[shot] ${file}  ${size.width}x${size.height}`)
}

/* ---------------- 正常启动 ---------------- */

app.whenReady().then(() => {
  app.setAppUserModelId('dev.xyzwp.airship')

  log.info('shell', '启动', {
    version: app.getVersion(),
    shotMode: SHOT_MODE,
    platform: process.platform,
    userData: app.getPath('userData')
  })

  registerIpc({ shotMode: SHOT_MODE })

  // 子进程事件只投给归属应用的那个窗口
  setProcEmitter((owner, event) => sendTo(owner, event))

  const theme = readTheme()
  setCachedTheme(theme)
  log.info('shell', '主题', theme)

  // 提前发现外部工具，启动器第一帧就能显示"可用/不可用"
  log.info('shell', '工具发现结果', toolStatus())

  if (SHOT_MODE) {
    void runShotMode()
    return
  }

  createLauncher()
})

// 单实例：第二次启动把启动器唤到前台。
// 抢不到锁必须说清楚——否则第二次跑截图模式会静默退出，看着像卡死。
// 截图模式自己有独立 userData，不参与这把锁。
if (!SHOT_MODE) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    console.error('[airship] 已有一个飞船在运行（单实例锁被占）。关掉它再启动。')
    app.quit()
  } else {
    app.on('second-instance', () => bringLauncherToFront())
  }
}

app.on('window-all-closed', () => {
  proc.killAll()
  trayService.clearForShutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  proc.killAll()
  trayService.clearForShutdown()
})

process.on('uncaughtException', (err) => {
  log.error('shell', '主进程未捕获异常', { error: String(err), stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log.error('shell', '未处理的 Promise 拒绝', { reason: String(reason) })
})
