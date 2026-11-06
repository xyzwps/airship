// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { FakeAirship } from '@tests/helpers/fakeAirship'
import { mountUi, type Mount } from '@tests/helpers/mount'
import LifeApp from '@apps/life/LifeApp'
import { GROUPS, PATTERNS } from '@apps/life/patterns'

/**
 * LF 册子里"界面上看得见"的那一半（推演与图形库那一半在 rules.test.ts）。
 *
 * jsdom 没有 2D 上下文，网格上一个像素都画不出来——所以这里只断言文字、
 * 档位选中态与世代计数，"网格范围看不看得见"归 `just shot`。
 * 一格几像素由可视区算，jsdom 量出来是 0 → 落到最小那一档 1 像素，
 * 涂格子的用例都从状态行把那个数读回来再算坐标，不写死。
 */

async function open(): Promise<Mount> {
  const fake = new FakeAirship({ id: 'life' })
  const m = await mountUi(<LifeApp />, { fake })
  await m.settle()
  return m
}

function stat(m: Mount): string {
  return (m.field('stat')?.textContent ?? '').trim()
}

/** 状态行念出的那一格像素 */
function cellPx(m: Mount): number {
  return Number(stat(m).match(/一格 (\d+) 像素/)?.[1] ?? 0)
}

/** 等真实时间走一段（播放用的是 setInterval，不靠假定时器） */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function canvasEvent(m: Mount, type: string, init: Record<string, unknown>): Promise<void> {
  const canvas = m.container.querySelector('canvas')
  if (!canvas) throw new Error('界面上没有网格')
  await act(async () => {
    canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }))
  })
}

/** 按住左键从一格拖到另一格（坐标按状态行那一格像素算） */
async function drag(m: Mount, from: [number, number], to: [number, number]): Promise<void> {
  const px = cellPx(m)
  const point = ([x, y]: [number, number]) => ({ clientX: x * px + px / 2, clientY: y * px + px / 2 })
  await canvasEvent(m, 'mousedown', { ...point(from), button: 0 })
  await canvasEvent(m, 'mousemove', { ...point(to), button: 0 })
  await act(async () => {
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await m.settle()
}

async function clear(m: Mount): Promise<void> {
  await m.pressIn('[data-test="clear"]')
}

/** 手风琴：要点的图形在哪一组，就先把那一组展开（已经开着就不动它） */
async function showGroup(m: Mount, group: string): Promise<void> {
  const head = m.field(`group-${group}`)
  if (head?.getAttribute('aria-expanded') !== 'true') await m.pressIn(`[data-test="group-${group}"]`)
}

describe('网格与那一格多大（LF-001 / LF-026 / LF-005）', () => {
  it('LF-001 状态行念得出此刻的网格与一格多大', async () => {
    const m = await open()
    expect(stat(m)).toContain('网格 100×100')
    expect(stat(m)).toMatch(/一格 \d+ 像素/)
    // 旧的"画布 1000×1000"那一层说法整个不见了
    expect(m.text()).not.toContain('画布 1000×1000')
    m.unmount()
  })

  it('LF-026 画布边长就是格数乘那一格像素，且界面上没有像素档那一族键', async () => {
    const m = await open()
    const canvas = m.container.querySelector('canvas') as HTMLElement
    const px = cellPx(m)
    expect(px).toBeGreaterThan(0)
    expect(canvas.style.width).toBe(`${100 * px}px`)
    expect(canvas.style.height).toBe(`${100 * px}px`)
    // 缩放整族删了：既没有「适应」，也没有 4px/8px/16px/32px
    for (const gone of ['fit', '4', '8', '16', '32']) expect(m.field(`zoom-${gone}`)).toBeNull()
    expect(m.text()).not.toContain('适应')
    m.unmount()
  })

  it('LF-005 换网格大小是重开：新格数、第 0 代、跑着的停下', async () => {
    const m = await open()
    await m.pressIn('[data-test="grid-200"]')
    expect(stat(m)).toContain('网格 200×200')
    expect(stat(m)).toContain('第 0 代 · 存活 5')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.text()).toContain('换成 200×200 的网格，从第 0 代开始')
    expect(m.field('grid-200')?.getAttribute('aria-pressed')).toBe('true')
    expect(m.field('grid-100')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.field('grid-300')?.getAttribute('aria-pressed')).toBe('false')
    // 换档以后那一格像素由可视区重算，画布边长仍然等于格数乘它
    const canvas = m.container.querySelector('canvas') as HTMLElement
    expect(canvas.style.width).toBe(`${200 * cellPx(m)}px`)
    m.unmount()
  })
})

describe('世代往前走（LF-010 / LF-011 / LF-012）', () => {
  it('LF-010 单步一次，世代加一且画面真的推进一代', async () => {
    const m = await open()
    await showGroup(m, 'oscillator')
    await m.pressIn('[data-test="pattern-blinker"]')
    expect(stat(m)).toContain('第 0 代 · 存活 3')
    await m.pressIn('[data-test="step"]')
    expect(stat(m)).toContain('第 1 代 · 存活 3')
    await m.pressIn('[data-test="step"]')
    expect(stat(m)).toContain('第 2 代 · 存活 3')
    m.unmount()
  })

  it('LF-011 播放按档子的节奏自己走，暂停停在当前代', async () => {
    const m = await open()
    await showGroup(m, 'oscillator')
    await m.pressIn('[data-test="pattern-blinker"]')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    await m.pressIn('[data-test="play"]')
    expect(m.field('play')?.getAttribute('title')).toBe('暂停')
    await wait(500)
    const running = Number(stat(m).match(/第 (\d+) 代/)?.[1] ?? 0)
    expect(running).toBeGreaterThan(0)
    await m.pressIn('[data-test="play"]')
    expect(m.field('play')?.getAttribute('title')).toBe('播放')
    await wait(300)
    expect(stat(m)).toContain(`第 ${running} 代`)
    m.unmount()
  })

  it('LF-012 全灭了不用人守着，它自己停下并说一句', async () => {
    const m = await open()
    await clear(m)
    await drag(m, [10, 10], [10, 10])
    expect(stat(m)).toContain('存活 1')
    await m.pressIn('[data-test="play"]')
    await wait(500)
    expect(stat(m)).toContain('存活 0')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.text()).toContain('全灭了，停下来')
    m.unmount()
  })
})

describe('边界那一档（LF-029）', () => {
  it('LF-029 边界有两颗键，默认亮着环绕，换档不清盘也不动世代', async () => {
    const m = await open()
    expect(m.field('edge-wrap')?.getAttribute('aria-pressed')).toBe('true')
    expect(m.field('edge-wall')?.getAttribute('aria-pressed')).toBe('false')
    await drag(m, [1, 1], [3, 1])
    await m.pressIn('[data-test="step"]')
    await m.pressIn('[data-test="step"]')
    const before = stat(m)
    await m.pressIn('[data-test="edge-wall"]')
    expect(m.field('edge-wall')?.getAttribute('aria-pressed')).toBe('true')
    expect(m.field('edge-wrap')?.getAttribute('aria-pressed')).toBe('false')
    // 换档改的是下一步怎么数邻居，不是现在画了什么
    expect(stat(m)).toBe(before)
    m.unmount()
  })
})

describe('玩家自己画初始图形（LF-013 / LF-014 / LF-015 / LF-016）', () => {
  it('LF-013 按下去那格是死的，这一笔一路涂活', async () => {
    const m = await open()
    await clear(m)
    await drag(m, [1, 1], [3, 1])
    expect(stat(m)).toContain('第 0 代 · 存活 3')
    m.unmount()
  })

  it('LF-014 按下去那格是活的，这一笔就是擦', async () => {
    const m = await open()
    await clear(m)
    await drag(m, [1, 1], [3, 1])
    await drag(m, [2, 1], [3, 1])
    expect(stat(m)).toContain('存活 1')
    m.unmount()
  })

  it('LF-015 清空网格把世代与跑着的键一起归位', async () => {
    const m = await open()
    await clear(m)
    await drag(m, [1, 1], [3, 1])
    await m.pressIn('[data-test="play"]')
    await wait(200)
    await clear(m)
    expect(stat(m)).toContain('第 0 代 · 存活 0')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.text()).toContain('网格清空了')
    m.unmount()
  })

  it('LF-016 随机那一下从第 0 代开始，也不是空的', async () => {
    const m = await open()
    await clear(m)
    await drag(m, [1, 1], [2, 2])
    await m.pressIn('[data-test="random"]')
    const cells = Number(stat(m).match(/存活 (\d+)/)?.[1] ?? 0)
    expect(stat(m)).toContain('第 0 代')
    expect(cells).toBeGreaterThan(0)
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.text()).toContain('随机铺了一片，从第 0 代开始')
    m.unmount()
  })
})

describe('经典图形的手风琴（LF-017 / LF-027 / LF-023 / LF-024）', () => {
  it('LF-017 图形库是手风琴：五组标题依次在，一次只展开一组', async () => {
    const m = await open()
    const html = m.html()
    let last = -1
    for (const group of GROUPS) {
      const head = m.field(`group-${group.id}`)
      expect(head, `组「${group.name}」要有组头`).not.toBeNull()
      const at = html.indexOf(`>${group.name}<`)
      expect(at, `组「${group.name}」排在面板里`).toBeGreaterThan(-1)
      expect(at > last, `组「${group.name}」排在前面的组之后`).toBe(true)
      last = at
      // 组头带着自己的个数
      expect(head!.textContent).toContain(String(PATTERNS.filter((p) => p.group === group.id).length))
    }
    // 只有第一组开着；其余四组的图形在界面上读不到
    expect(m.field(`group-${GROUPS[0]!.id}`)?.getAttribute('aria-expanded')).toBe('true')
    for (const group of GROUPS.slice(1)) {
      expect(m.field(`group-${group.id}`)?.getAttribute('aria-expanded')).toBe('false')
      for (const p of PATTERNS.filter((x) => x.group === group.id)) {
        expect(m.field(`pattern-${p.id}`), `${p.name} 在收起的那一组里`).toBeNull()
      }
    }
    for (const p of PATTERNS.filter((x) => x.group === GROUPS[0]!.id)) {
      expect(m.text(), p.name).toContain(p.name)
      expect(m.text(), p.name).toContain(p.note)
    }
    m.unmount()
  })

  it('LF-027 点组头换展开的那一组，再点一次收起来', async () => {
    const m = await open()
    await m.pressIn('[data-test="group-spaceship"]')
    expect(m.field('pattern-glider')?.textContent).toContain('滑翔机')
    expect(m.field('pattern-lwss')?.textContent).toContain('轻量飞船')
    expect(m.field('pattern-block')).toBeNull()
    expect(m.field('pattern-blinker')).toBeNull()
    await m.pressIn('[data-test="group-spaceship"]')
    for (const p of PATTERNS) expect(m.field(`pattern-${p.id}`), p.name).toBeNull()
    m.unmount()
  })

  it('LF-023 点图形是换一个起点：网格只剩它、世代归零、跑着的停下', async () => {
    const m = await open()
    await showGroup(m, 'still')
    await m.pressIn('[data-test="pattern-block"]')
    await m.pressIn('[data-test="play"]')
    await wait(200)
    await showGroup(m, 'spaceship')
    await m.pressIn('[data-test="pattern-glider"]')
    expect(stat(m)).toContain('第 0 代 · 存活 5')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    expect(m.text()).toContain('换上「滑翔机」，从第 0 代开始')
    m.unmount()
  })

  it('LF-024 打开就有一只滑翔机停在第 0 代，点播放它会走不会碎', async () => {
    const m = await open()
    expect(stat(m)).toContain('第 0 代 · 存活 5')
    expect(m.field('play')?.getAttribute('aria-pressed')).toBe('false')
    await m.pressIn('[data-test="play"]')
    await wait(500)
    const gen = Number(stat(m).match(/第 (\d+) 代/)?.[1] ?? 0)
    expect(gen).toBeGreaterThan(0)
    expect(stat(m)).toContain('存活 5')
    m.unmount()
  })
})
