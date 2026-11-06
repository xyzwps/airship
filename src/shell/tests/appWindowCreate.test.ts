import { describe, expect, it, vi } from 'vitest'

/**
 * SH-015 / SH-016 / SH-018：窗口尺寸与摆放。
 *
 * 这里跑的是**真的 openAppWindow**，只把 BrowserWindow 换成记账的假壳——
 * 判据是"传进去的构造参数"：宽高来自清单、没有坐标、关掉再开也不留下任何窗口记录。
 */

interface FakeOptions {
  width?: number
  height?: number
  x?: number
  y?: number
  show?: boolean
}

let nextContentsId = 1

class FakeBrowserWindow {
  static created: FakeBrowserWindow[] = []
  options: FakeOptions
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
  setAppUserModelId(): void {}
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
  const root = p(__dirname, '.tmp', 'create-userData')
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

    // vcp 没写，两个维度都跟壳的默认
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

  it('SH-018 关掉再重开，位置由系统重新摆；壳里不存在窗口记录', () => {
    resetWindows()
    openAppWindow('dagogo')
    const win = lastWindow()
    // 创建时就没有坐标：位置交给系统
    expect(win.options.x).toBeUndefined()
    expect(win.options.y).toBeUndefined()

    win.bounds = { width: 600, height: 800, x: 1780, y: 940 }
    win.close()

    // 关掉之后：壳设置里没有任何窗口状态的键
    const keys = Object.keys(settings.dump('shell')).filter((k) => /Window|appWindow|launcherWindow/.test(k))
    expect(keys, `设置里出现了窗口状态的键：${keys.join(', ')}`).toEqual([])

    // 重开还是不带坐标
    openAppWindow('dagogo')
    expect(lastWindow().options.x).toBeUndefined()
    expect(lastWindow().options.y).toBeUndefined()
  })
})
