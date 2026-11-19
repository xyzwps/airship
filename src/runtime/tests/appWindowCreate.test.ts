import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, WINDOWS_ICON_NAME, notRegistered } from '@airship/contract'

/**
 * SH-015 / SH-016 / SH-018：窗口尺寸与摆放；BR-011：建窗口那一刻的安全参数；
 * SH-010 / SH-034 / SH-035：任务栏上那颗按钮的身份、图标与重启动作。
 *
 * 这里跑的是**真的 openAppWindow**，只把 BrowserWindow 换成记账的替身——
 * 判据是"传进去的构造参数"与"交给外壳的那一份身份"：宽高来自清单、没有坐标、
 * 关掉再开也不留下任何窗口记录；身份带 id 后缀、图标是磁盘上那份、命令行两段带引号。
 *
 * 替身只实现真 API 面上存在的方法（TD-001 那处假绿就是这么来的）：
 * BrowserWindow 上**没有** `setAppUserModelId`，任务栏身份走 `setAppDetails`。
 */

interface FakeOptions {
  width?: number
  height?: number
  x?: number
  y?: number
  show?: boolean
  icon?: string
  webPreferences?: { webSecurity?: boolean }
}

/** 与 Electron 的 AppDetailsOptions 同形（win32 专有；relaunchCommand 与显示名必须成对） */
interface FakeAppDetails {
  appId: string
  appIconPath?: string
  relaunchCommand?: string
  relaunchDisplayName?: string
}

let nextContentsId = 1

/** 替身 electron 的 userData 根：落盘的图标要在这里找 */
const FAKE_USER_DATA = join(__dirname, '.tmp', 'create-userData')

class FakeBrowserWindow {
  static created: FakeBrowserWindow[] = []
  options: FakeOptions
  appDetails: FakeAppDetails | null = null
  bounds = { width: 1100, height: 740, x: 0, y: 0 }
  handlers: Record<string, Array<() => void>> = {}
  destroyed = false
  minimized = false
  maximized = false
  webContents = {
    id: nextContentsId++,
    send: (): void => undefined,
    on: (): void => undefined,
    setWindowOpenHandler: (): void => undefined,
    getOSProcessId: (): number => 1234
  }

  constructor(options: FakeOptions) {
    this.options = options
    FakeBrowserWindow.created.push(this)
  }

  setTitle(): void {}
  show(): void {}
  focus(): void {}
  restore(): void {
    this.minimized = false
  }
  isMinimized(): boolean {
    return this.minimized
  }
  isMaximized(): boolean {
    return this.maximized
  }
  maximize(): void {
    this.maximized = true
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
  getBounds(): typeof this.bounds {
    return this.bounds
  }
  loadFile(): void {}
  loadURL(): void {}
  setAppDetails(details: FakeAppDetails): void {
    this.appDetails = details
  }
  once(event: string, fn: () => void): void {
    ;(this.handlers[event] ??= []).push(fn)
  }
  on(event: string, fn: () => void): void {
    ;(this.handlers[event] ??= []).push(fn)
  }
  /** 用户点关闭：走 Electron 的事件顺序 */
  close(): void {
    for (const fn of this.handlers['close'] ?? []) fn()
    this.destroyed = true
    for (const fn of this.handlers['closed'] ?? []) fn()
  }
}

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  const { rmSync: rm, mkdirSync: mk } = await import('node:fs')
  const root = FAKE_USER_DATA
  rm(root, { recursive: true, force: true })
  mk(root, { recursive: true })
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    BrowserWindow: Object.assign(FakeBrowserWindow, { fromWebContents: () => null }),
    ipcMain: { handle: () => undefined, on: () => undefined },
    dialog: {},
    clipboard: {},
    shell: {},
    Notification: class {}
  }
})

const { openAppWindow } = await import('../main/windows')
const { settings } = await import('../main/services/settings')
const { metaOf } = await import('../main/services/appRegistry')
const { readArchiveEntry } = await import('../main/services/packageArchive')
const { relaunchCommandFor, runtimeDirFromArgv } = await import('../main/services/taskbarIdentity')
const { installRawPackage, packageFixtureRoot } = await import('./helpers/packages')
const { registerPackageAt } = await import('../main/services/packageRegistry')

/** 上一条用例留下的窗口先关掉：台账是模块级的，不关就会走"聚焦已有"而不是新建 */
function resetWindows(): void {
  for (const w of FakeBrowserWindow.created) if (!w.destroyed) w.close()
  FakeBrowserWindow.created.length = 0
}

function lastWindow(): FakeBrowserWindow {
  return FakeBrowserWindow.created[FakeBrowserWindow.created.length - 1]!
}

describe('窗口尺寸只认清单，位置与尺寸都不记', () => {
  it('SH-015 清单写了尺寸的应用，开出来就是那个尺寸', () => {
    resetWindows()
    // 打勾勾的清单写着 defaultWidth: 600 / defaultHeight: 800
    openAppWindow('dagogo')
    expect(lastWindow().options).toMatchObject({ width: 600, height: 800 })

    // vcp 没写，两个维度都跟 runtime 的默认
    openAppWindow('vcp')
    expect(lastWindow().options).toMatchObject({ width: 1100, height: 740 })
  })

  it('SH-016 手动拖大的尺寸不留到下次', () => {
    resetWindows()
    openAppWindow('dagogo')
    const first = lastWindow()
    // 用户把它拉成 1125×743 再关掉
    first.bounds = { width: 1125, height: 743, x: 120, y: 90 }
    first.close()

    openAppWindow('dagogo')
    expect(lastWindow().options).toMatchObject({ width: 600, height: 800 })
  })

  it('SH-018 关掉再重开，位置由系统重新摆；runtime 里不存在窗口记录', () => {
    resetWindows()
    openAppWindow('dagogo')
    const win = lastWindow()
    // 创建时就没有坐标：位置交给系统
    expect(win.options.x).toBeUndefined()
    expect(win.options.y).toBeUndefined()

    win.bounds = { width: 600, height: 800, x: 1780, y: 940 }
    win.close()

    // 关掉之后：应用自己的设置里没有任何窗口状态的键，runtime 自己更没有设置文件
    const keys = Object.keys(settings.dump('dagogo')).filter((k) => /Window|appWindow|launcherWindow/.test(k))
    expect(keys, `设置里出现了窗口状态的键：${keys.join(', ')}`).toEqual([])

    // 重开还是不带坐标
    openAppWindow('dagogo')
    expect(lastWindow().options.x).toBeUndefined()
    expect(lastWindow().options.y).toBeUndefined()
  })
})

/**
 * BR-011：`net` 能力换到的那一档跨源豁免（判据见 `src/runtime/specs/bridge.md`）。
 *
 * 这里钉的是建窗口那一刻传进去的安全参数：窗口构造之后就没机会再改了，
 * "声明了 net 的应用在自己窗口里读得到不回跨源许可的 http 服务响应"的前提就在这一位上。
 * 清单是真的（setup.ts 把仓库的 `app.ts` 落成归档并注册进活动包表）：s3 声明了 net，dagogo 没有。
 */
describe('声明了 net 的应用窗口豁免同源策略', () => {
  it('BR-011 只有声明 net 的应用窗口豁免同源策略，其余窗口照旧', () => {
    resetWindows()
    openAppWindow('s3')
    expect(lastWindow().options.webPreferences?.webSecurity, 's3 声明了 net，它的窗口该豁免同源策略').toBe(false)

    openAppWindow('dagogo')
    expect(lastWindow().options.webPreferences?.webSecurity, 'dagogo 没声明 net，同源策略必须照旧').toBe(true)
  })
})

describe('硬开一个没注册的应用', () => {
  it('SH-014 念的是主进程那一句，不开窗口也不出现 Electron 的内部措辞', () => {
    resetWindows()
    let message = ''
    try {
      openAppWindow('ghost')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    // 措辞的唯一真源在契约层：主进程抛的就是这一句，渲染侧没有另一份
    expect(message).toBe(notRegistered('ghost'))
    expect(message).not.toMatch(/ERR_|Failed to load|Cannot find module/)
    expect(FakeBrowserWindow.created, '没注册的应用一个窗口都不许建').toHaveLength(0)

    // 渲染侧（SDK）没有自己拼的那一套：这句措辞只许住在契约层与主进程
    const sdkDir = join(__dirname, '..', '..', 'sdk')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'tests') continue
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && readFileSync(p, 'utf8').includes('没有注册这个应用')) hits.push(p)
      }
    }
    walk(sdkDir)
    expect(hits, `SDK 里出现了自己拼的拒绝措辞：${hits.join(', ')}`).toEqual([])
  })
})

/**
 * SH-010 / SH-034 / SH-035：任务栏上那颗按钮的身份、图标与重启动作。
 *
 * 三样都要在**真的 openAppWindow** 之后从替身窗口上读——从前这里记的是
 * `window.setAppUserModelId?.(...)`，BrowserWindow 上根本没有那个方法，
 * 可选链把失败吞成空操作，用例绿着而真机八个应用还是一颗按钮（TD-001）。
 * 命令行那一句的形状另外用纯函数钉一次，不依赖跑测试这台机器的 argv。
 */
describe('任务栏上每个应用是自己的那颗按钮', () => {
  it('SH-010 身份带应用 id 后缀，两个应用必然不同', () => {
    resetWindows()
    openAppWindow('dagogo')
    const dagogo = lastWindow().appDetails
    expect(dagogo, '窗口一次都没把身份交给外壳（setAppDetails 没被调过）').not.toBeNull()
    expect(dagogo!.appId).toBe('dev.xyzwp.airship.dagogo')

    openAppWindow('vcp')
    const vcp = lastWindow().appDetails!
    expect(vcp.appId).toBe('dev.xyzwp.airship.vcp')
    expect(vcp.appId).not.toBe(dagogo!.appId)
  })

  it('SH-034 交给外壳的图标是磁盘上那份，字节与包内那份相同；没有就喊出回落', () => {
    resetWindows()
    openAppWindow('dagogo')
    const details = lastWindow().appDetails!
    const inArchive = readArchiveEntry(join(packageFixtureRoot(), 'dagogo.airship'), WINDOWS_ICON_NAME)
    expect(inArchive, '工装包就该带派生 ico，否则这条钉不到东西').not.toBeNull()
    expect(details.appIconPath, '外壳只认磁盘路径').toBe(join(FAKE_USER_DATA, 'icons', 'dagogo.ico'))
    expect(existsSync(details.appIconPath!)).toBe(true)
    expect(Buffer.compare(readFileSync(details.appIconPath!), Buffer.from(inArchive!))).toBe(0)

    // 包里没有 icon.ico：窗口照样开、身份照样是应用那一个，只是不交图标，并且要把这声喊出来
    const manifest = JSON.stringify({
      id: 'noico',
      name: '没图标',
      description: '验图标回落的那一个包',
      capabilities: [],
      schemaVersion: SCHEMA_VERSION,
      sdkVersion: '0.0.0-test'
    })
    const { problems } = registerPackageAt(installRawPackage(packageFixtureRoot(), 'noico.airship', manifest))
    expect(problems, problems.join('\n')).toEqual([])
    openAppWindow('noico')
    const fallback = lastWindow()
    expect(fallback.appDetails!.appIconPath, '没有派生 ico 就不该交图标键').toBeUndefined()
    expect(fallback.appDetails!.appId).toBe('dev.xyzwp.airship.noico')
    expect(fallback.options.icon, '窗口自己的图标回落 runtime 那张母版').toContain(join('assets', 'icon.png'))

    const day = new Date()
    const logFile = join(
      FAKE_USER_DATA,
      'logs',
      `airship-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.log`
    )
    expect(readFileSync(logFile, 'utf8'), '回落不能默默过去').toContain('包里缺 icon.ico')
  })

  it('SH-035 重启动作与快捷方式同形：每段带引号，显示名是清单里的应用名', () => {
    resetWindows()
    openAppWindow('dagogo')
    const details = lastWindow().appDetails!
    const archive = join(packageFixtureRoot(), 'dagogo.airship')
    const command = details.relaunchCommand!
    expect(command.endsWith(`"${archive}"`), `命令行要以归档结尾并带引号：${command}`).toBe(true)
    expect(command, `每一段都得引号包住（路径里有空格也不散架）：${command}`).toMatch(/^(?:"[^"]*")(?: "[^"]*")+$/)
    expect(details.relaunchDisplayName).toBe(metaOf('dagogo')!.name)

    // 命令行本身的形状与这台机器的 argv 无关，纯函数两侧各钉一次
    expect(
      relaunchCommandFor({
        execPath: 'C:\\Program Files\\airship\\runtime\\airship.exe',
        runtimeDir: null,
        archive: 'C:\\Users\\me\\AppData\\Local\\airship\\apps\\life\\life.airship'
      })
    ).toBe(
      '"C:\\Program Files\\airship\\runtime\\airship.exe" "C:\\Users\\me\\AppData\\Local\\airship\\apps\\life\\life.airship"'
    )
    expect(
      relaunchCommandFor({
        execPath: 'D:\\tools\\electron.exe',
        runtimeDir: 'D:\\repo\\src\\runtime',
        archive: 'D:\\repo\\dist-apps\\life.airship'
      })
    ).toBe('"D:\\tools\\electron.exe" "D:\\repo\\src\\runtime" "D:\\repo\\dist-apps\\life.airship"')

    expect(runtimeDirFromArgv(['electron.exe', 'src/runtime', 'D:\\pkgs\\life.airship'])).toBe(resolve('src/runtime'))
    expect(runtimeDirFromArgv(['airship.exe', 'D:\\pkgs\\life.airship']), '打包后 argv[1] 就是归档，不多那一段').toBeNull()
  })
})
