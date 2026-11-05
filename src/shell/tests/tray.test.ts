import { describe, expect, it, vi } from 'vitest'

/**
 * TR-001 ~ TR-008：托盘只有一个图标，但可能多个应用都想要它。
 *
 * Tray / Menu / nativeImage 换成能记账的替身，`sendTo` 也换成登记表——
 * "点托盘只投占用那个窗口"这条必须看得见投递对象才算验到。
 */

interface TrayInstance {
  tooltips: string[]
  images: unknown[]
  menus: Array<Array<{ label?: string; enabled?: boolean; type?: string }>>
  handlers: Record<string, () => void>
  destroyed: boolean
}

const made: TrayInstance[] = []

vi.mock('electron', () => ({
  Tray: class {
    self: TrayInstance
    constructor(icon: unknown) {
      this.self = { tooltips: [], images: [icon], menus: [], handlers: {}, destroyed: false }
      made.push(this.self)
    }
    on(event: string, fn: () => void): void {
      this.self!.handlers[event] = fn
    }
    setImage(img: unknown): void {
      this.self!.images.push(img)
    }
    setToolTip(t: string): void {
      this.self!.tooltips.push(t)
    }
    setContextMenu(menu: { items: unknown[] }): void {
      this.self!.menus.push(menu.items as TrayInstance['menus'][number])
    }
    destroy(): void {
      this.self!.destroyed = true
    }
  },
  Menu: { buildFromTemplate: (items: unknown) => ({ items }) },
  nativeImage: {
    // 应用画上来的数字图标：非空；壳默认那张：空（模拟这台机器上没有 assets/tray.png）
    createFromDataURL: (url: string) => ({ isEmpty: () => url.length === 0, url }),
    createFromPath: () => ({ isEmpty: () => true }),
    createEmpty: () => ({ isEmpty: () => true })
  }
}))

const sent: Array<{ owner: string; event: unknown }> = []

vi.mock('../main/windows', () => ({
  sendTo: (owner: string, event: unknown) => sent.push({ owner, event })
}))

const { trayService } = await import('../main/services/tray')

function last(): TrayInstance {
  return made[made.length - 1]!
}

describe('一个托盘图标，占用者唯一', () => {
  it('TR-001 谁设置的就是谁占着，提示文字按它给的来', () => {
    trayService.set('dagogo', { tooltip: '打勾勾 · 今天勾掉 2 个，共 5 条' }, () => undefined)
    expect(trayService.owner).toBe('dagogo')
    expect(trayService.active).toBe(true)
    expect(last().tooltips.at(-1)).toBe('打勾勾 · 今天勾掉 2 个，共 5 条')
    trayService.clear('dagogo')
  })

  it('TR-002 只有占用者能清掉托盘，别人调是空操作', () => {
    trayService.set('dagogo', { tooltip: '打勾勾' }, () => undefined)

    trayService.clear('vcp')
    expect(trayService.owner).toBe('dagogo')
    expect(trayService.active).toBe(true)

    trayService.clear('dagogo')
    expect(trayService.owner).toBeNull()
    expect(trayService.active).toBe(false)
  })

  it('TR-003 退出时不分归属一律清掉', () => {
    trayService.set('dagogo', { tooltip: '打勾勾' }, () => undefined)
    trayService.clearForShutdown()
    expect(trayService.owner).toBeNull()
    expect(trayService.active).toBe(false)
    expect(last().destroyed).toBe(true)
  })

  it('TR-004 提示文字截到 120 字', () => {
    const long = '今'.repeat(200)
    trayService.set('dagogo', { tooltip: long }, () => undefined)
    expect(last().tooltips.at(-1)).toBe('今'.repeat(120))
    expect(last().menus.at(-1)![0]!.label).toBe('今'.repeat(60))
    trayService.clearForShutdown()
  })

  it('TR-005 应用画好的数字图标交上来就用，没画就用壳默认的', () => {
    trayService.set('dagogo', { tooltip: '打勾勾 · 2/5' }, () => undefined)
    // 默认图标那张在本机是空的（替身里 createFromPath 给空图）
    expect((last().images[0] as unknown as { isEmpty: () => boolean }).isEmpty()).toBe(true)

    trayService.set('dagogo', { tooltip: '打勾勾 · 2/5', iconDataUrl: 'data:image/png;base64,AAAA' }, () => undefined)
    expect(last().images.at(-1)).toMatchObject({ url: 'data:image/png;base64,AAAA' })

    // 只给徽标文字：不报错，图标保持上一张
    trayService.set('dagogo', { tooltip: '打勾勾 · 2/5', badge: '2/5' }, () => undefined)
    expect(last().tooltips.at(-1)).toBe('打勾勾 · 2/5')
    trayService.clearForShutdown()
  })

  it('TR-006 右键菜单里有点得动的两项', () => {
    trayService.set('dagogo', { tooltip: '打勾勾 · 今天勾掉 2 个' }, () => undefined)
    const items = last().menus.at(-1)!
    expect(items.map((i) => i.label)).toEqual(['打勾勾 · 今天勾掉 2 个', undefined, '打开飞船', '退出'])
    expect(items[0]!.enabled).toBe(false)
    expect(items[2]!.label).toBe('打开飞船')
    expect(items[3]!.label).toBe('退出')
    trayService.clearForShutdown()
  })

  it('TR-007 点托盘 → 事件只投占用那个应用；TR-008 默认唤启动器，应用可以自己不要', () => {
    const brought: number[] = []
    const front = (): void => {
      brought.push(1)
    }

    trayService.set('dagogo', { tooltip: '打勾勾' }, front)
    sent.length = 0
    last().handlers['click']!()
    expect(sent).toEqual([{ owner: 'dagogo', event: { kind: 'tray:click' } }])
    expect(brought.length).toBe(1)

    // 应用说不要唤启动器
    trayService.set('dagogo', { tooltip: '打勾勾', focusOnClick: false }, front)
    sent.length = 0
    last().handlers['click']!()
    expect(brought.length).toBe(1)
    expect(sent.map((s) => s.owner)).toEqual(['dagogo'])

    // 没设过托盘时点它什么也不发生
    trayService.clearForShutdown()
    const before = sent.length
    const orphan = made[made.length - 2]
    if (orphan?.handlers['click']) orphan.handlers['click']()
    expect(sent.length).toBe(before)
  })
})
