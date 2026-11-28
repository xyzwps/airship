import { app, dialog, ipcMain, type WebContents } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { profileDir } from './services/paths'
import { registerAirshipScheme, serveAirshipPackages } from './services/packageProtocol'
import { log } from './services/logging'
import { backendHost, setBackendEmitter } from './services/backendHost'
import { trayService } from './services/tray'
import { appsAvailableOn, registerPackage, type InstalledPackage } from './services/appRegistry'
import { archivesFromArgv } from './services/runArgs'
import { usageLine } from '@airship/contract'
import {
  currentPlatform,
  openAppWindow,
  ownerOfContents,
  sendTo,
  windowMetrics
} from './windows'

/**
 * airship runtime 主进程。
 *
 * runtime 自己没有界面：跑哪些包由命令行决定（`airship.exe <id>.airship`，
 * 可以一次指多份），注册一份、开一个窗口。没带包路径就念用法退出，
 * 不存在"开一个空启动器等人挑"这条路。
 *
 * 单实例：第二次启动把 argv 转发给已在跑的那一份——同 id 同归档聚焦，
 * 同 id 异归档拒（措辞在契约层），新包直接开窗口。
 * 确认在安装期完成（应用安装器欢迎页念目录与后台，PK-033）；直跑不再弹任何卡片。
 *
 * 截图模式（AIRSHIP_SHOT=1 --shot）：argv 指来的每个应用窗口各一张，
 * 都等渲染侧报就绪再 capturePage——"真的跑起来看到了"才算交付。
 */

// 应用的名字钉死为 airship：Electron 的默认路径与外壳身份都取 package.json 的 name，
// 而那个 name 现在是 @airship/runtime。落点由下面那一句显式钉住，这个名字留着是让
// 日志、通知与外壳身份念得对——它是用户数据的一部分，不是包名。
app.setName('airship')

const SHOT_MODE = process.env.AIRSHIP_SHOT === '1' && process.argv.includes('--shot')

/**
 * Electron 自己的浏览器档单独一区：`~/.airship/profile`（见 paths.ts 的布局）。
 *
 * 家目录整份由 `airshipHome()` 定——dev 时 CLI 给 `AIRSHIP_HOME` 指到项目里的 `.airship-dev/<id>`，
 * 截图模式换到 `~/.airship-shot`，两者都不碰日常那一份，也不会你正开着应用看界面时
 * 我跑一次截图就静默退出（抢不到锁）或刷一堆"Unable to move the cache"。
 * 验证工装不该踩在正在使用的人身上。
 */
app.setPath('userData', profileDir())

/** 命令行指来的包路径，可以有多份；相对路径按 cwd 解（手敲才给相对，快捷方式给绝对） */
const ARCHIVES = archivesFromArgv(process.argv, process.cwd())

/**
 * `airship://` 的方案属性必须在 app ready 之前注册，所以这一句留在模块顶层。
 * 处理器在 `whenReady` 里挂（Electron 要求协议注册与窗口创建都在 ready 之后）。
 */
registerAirshipScheme()

/* ---------------- 跑一个包：开窗 ---------------- */

/**
 * 开窗口失败（平台不支持这类）响亮念出来，不静默少一个窗口。
 * 返回是否真的开了（或聚焦了）窗口。授权已在安装期完成（PK-033），这里不再确认。
 */
function runPackage(pkg: InstalledPackage): boolean {
  try {
    openAppWindow(pkg.meta.id)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('runtime', '窗口开不出来', { id: pkg.meta.id, message })
    dialog.showMessageBoxSync({ type: 'error', title: 'airship runtime', message })
    return false
  }
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
    if (!owner) return
    const start = openedAt.get(owner) ?? Date.now()
    marks.push({ app: owner, name: String(name), ms: Date.now() - start })
  })

  /** 页面上现在写着什么——加载失败时这是唯一看得见的线索 */
  const pagePeek = async (sender: WebContents): Promise<string> => {
    const probe = 'document.body ? document.body.innerText.slice(0, 200) : ""'
    try {
      return JSON.stringify(await sender.executeJavaScript(probe))
    } catch (e) {
      return `读不到（${e instanceof Error ? e.message : String(e)}）`
    }
  }

  const waitReady = async (sender: WebContents, label: string): Promise<void> => {
    // 有界等待：加载不出来的时候必须喊出来并说出它在等哪个 URL，
    // 静默转圈等于把一次失败变成一次看不懂的挂死
    const deadline = Date.now() + 30_000
    while (!readySenders.has(sender.id)) {
      if (Date.now() > deadline) {
        throw new Error(
          `${label} 在 30 秒内没有报就绪。当前 URL：${sender.getURL()}；页面文本开头：${await pagePeek(sender)}`
        )
      }
      await sleep(50)
    }
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

  const metrics: { label: string; workingSetKB: number }[] = []

  for (const meta of appsAvailableOn(currentPlatform())) {
    openedAt.set(meta.id, Date.now())
    const window = openAppWindow(meta.id)
    const isAutotestTarget = autotest !== null && autotest.app === meta.id

    // 就绪信号：该窗口的应用组件 chunk 已 resolve。
    // 不能等"注册了 autotest 监听"——普通应用根本没有那个钩子，会死等。
    await waitReady(window.webContents, meta.id)

    if (isAutotestTarget && autotest) {
      // 自动导入要往应用里推事件，得等它把监听注册上
      await waitListener(meta.id)
      window.webContents.send('shot:autotest', autotest)
      // 导入 + 解析 + 首屏渲染比空界面慢得多，给足时间
      await sleep(9000)
    } else {
      // 3 秒：wsld 第一屏要等一条真 `wslc list`（冷启动实测 2.5s，热了 0.1s），
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

// 单实例：第二次启动把包路径转发给已在跑的那一份。
// 抢不到锁不是错误——argv 会由 Electron 自动交给第一实例的 second-instance。
// **锁要在 whenReady 之前抢，且抢不到时 whenReady 里一步都不走**：
// 不然第二实例也会把启动跑完、开出一扇重复的窗再退出（真机抓到过：两扇 dagogo 各开一次）。
// 截图模式整份家换到 `~/.airship-shot`，不参与这把锁。
const GOT_LOCK = SHOT_MODE || app.requestSingleInstanceLock()
if (!GOT_LOCK) {
  console.error('[airship] 已有一个 airship runtime 在运行，这次的包路径转发给它。')
  app.quit()
} else if (!SHOT_MODE) {
  app.on('second-instance', (_event, argv, cwd) => {
    // 转发来的 argv 里相对路径按**第二实例的 cwd** 解，不是第一实例的
    const incoming = archivesFromArgv(argv, cwd)
    if (incoming.length === 0) {
      dialog.showMessageBoxSync({ type: 'info', title: 'airship runtime', message: usageLine() })
      return
    }
    for (const archive of incoming) {
      try {
        // 同 id 同归档：registerPackage 返回已在表里的那一份，openAppWindow 聚焦
        runPackage(registerPackage(archive))
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log.error('runtime', '转发来的包跑不起来', { archive, message })
        dialog.showMessageBoxSync({ type: 'error', title: 'airship runtime', message })
      }
    }
  })
}

app.whenReady().then(() => {
  if (!GOT_LOCK) return
  app.setAppUserModelId('dev.xyzwp.airship')
  // 包的文档面：airship://<id>/… 只读到那一个包（处理器要在 ready 之后挂）
  serveAirshipPackages()

  registerIpc({ shotMode: SHOT_MODE })

  // 后端程序主动推的事件只回归属窗口，没有全局广播
  setBackendEmitter((owner, event) => sendTo(owner, event))

  // 没带包路径：念用法，不开任何界面
  if (ARCHIVES.length === 0) {
    dialog.showMessageBoxSync({ type: 'info', title: 'airship runtime', message: usageLine() })
    app.exit(1)
    return
  }

  // 注册先于第一行日志：跑了哪些包、哪个包不合格，都要能在日志里读到。
  // 不合格响亮退出，不静默少一个窗口。
  const packages: InstalledPackage[] = []
  for (const archive of ARCHIVES) {
    try {
      packages.push(registerPackage(archive))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[airship] ${message}`)
      dialog.showMessageBoxSync({ type: 'error', title: 'airship runtime', message })
      app.exit(1)
      return
    }
  }

  log.info('runtime', '启动', {
    version: app.getVersion(),
    shotMode: SHOT_MODE,
    platform: process.platform,
    userData: app.getPath('userData'),
    跑着的包: packages.map((p) => p.meta.id)
  })

  if (SHOT_MODE) {
    // 截图工装自己失败就必须响亮退出：挂在这儿比报错难查十倍
    void runShotMode().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      log.error('runtime', '截图模式失败', { message })
      console.error(`[shot] 失败：${message}`)
      app.exit(1)
    })
    return
  }

  let opened = 0
  for (const pkg of packages) {
    if (runPackage(pkg)) opened++
  }
  // 一个窗口都没开出来（全都开失败了）：没有理由继续占着进程
  if (opened === 0) app.quit()
})

app.on('window-all-closed', () => {
  // 截图模式逐个开窗、按下快门、关掉再下一个，生命周期由 runShotMode 自己管（末尾 app.quit）。
  // 这里若跟着 quit，截完第一个窗口就退出，后面几个永远截不到——启动器退场后抓到的一次回归：
  // 从前启动器那扇窗一直开着，window-all-closed 不会在截图途中触发。
  if (SHOT_MODE) return
  backendHost.killAll()
  trayService.clearForShutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  backendHost.killAll()
  trayService.clearForShutdown()
})

process.on('uncaughtException', (err) => {
  log.error('runtime', '主进程未捕获异常', { error: String(err), stack: err.stack })
})

process.on('unhandledRejection', (reason) => {
  log.error('runtime', '未处理的 Promise 拒绝', { reason: String(reason) })
})