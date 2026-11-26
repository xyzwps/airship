// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAirship, mountUi } from '@airship/sdk/testing'
import AirshipIconApp from '../AirshipIconApp.tsx'
import { app } from '../app.ts'
import { describeIco, frameSizesPhrase, ICON_FRAME_SIZES } from '../ico.ts'
import { PNG_SIGNATURE } from './helpers/png.ts'
import { squarePng } from './helpers/png.ts'

/**
 * 界面层（册子：specs/airship-icon.md）。
 *
 * jsdom 没有 2D 画布，所以光栅化那一步换成替身：它按真判据 `mayTaintCanvas` 决定念哪句话，
 * 帧内容给的是 `helpers/png.ts` 造的真 PNG（签名与 IHDR 都真），于是 `ico.ts` 那套判据
 * 在这条链上跑的与真机同一份。"像素真画出来了没有"归截图走查。
 */
const TAINTED = '画不动这份 SVG：它含 foreignObject 或外部引用，浏览器不把像素交出来。'
const BROKEN = '这份 SVG 读不开：根标签没闭合，或语法有问题。'

const raster = vi.hoisted(() => ({ calls: [] as Array<{ sizes: number[]; text: string }> }))

vi.mock('../rasterize.ts', async () => {
  const { mayTaintCanvas } = await import('../svgFit.ts')
  const TAINTED_MESSAGE = '画不动这份 SVG：它含 foreignObject 或外部引用，浏览器不把像素交出来。'
  const BROKEN_SVG_MESSAGE = '这份 SVG 读不开：根标签没闭合，或语法有问题。'
  return {
    TAINTED_MESSAGE,
    BROKEN_SVG_MESSAGE,
    svgToFrames: async (svgText: string, sizes: number[]) => {
      raster.calls.push({ sizes: [...sizes], text: svgText })
      if (mayTaintCanvas(svgText)) throw new Error(TAINTED_MESSAGE)
      // 真机那条是 img.onerror：根标签没闭合时图片加载不开。替身按同一条件抛同一句
      if (/<svg\b/i.test(svgText) && !/<\/svg>/i.test(svgText)) throw new Error(BROKEN_SVG_MESSAGE)
      return sizes.map((size) => ({ size, png: squarePng(size) }))
    },
    svgToPng: async (svgText: string, size: number) => squarePng(size)
  }
})

const GOOD_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#1a6fc1"/></svg>'
const ATTR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="96px" height="64px"><rect width="96" height="64" fill="#1a6fc1"/></svg>'
const BARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="#1a6fc1"/></svg>'
const FOREIGN_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><foreignObject width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml">字</div></foreignObject></svg>'
const UNCLOSED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24"/>'

function makeFake(picks: Array<string[] | string | null> = [], files: Record<string, string> = {}) {
  return new FakeAirship({ id: app.id, capabilities: app.capabilities, picks, files })
}

async function open(picks: Array<string[] | string | null> = [], files: Record<string, string> = {}) {
  const fake = makeFake(picks, files)
  const m = await mountUi(<AirshipIconApp api={fake.api} />, { fake })
  await m.settle()
  return { fake, m }
}

beforeEach(() => {
  raster.calls.length = 0
})

describe('图标工坊的输入', () => {
  it('IC-001 第一屏读得到三条来路', async () => {
    const { m } = await open()
    expect(m.text()).toContain('图标工坊')
    expect(m.text()).toContain('选 SVG 文件')
    expect(m.text()).toContain('拖一份 .svg 进来、按「选 SVG 文件」，或把源码贴进下面那个框。')
    m.unmount()
  })

  it('IC-002 根标签没有 svg 的就拒在门口', async () => {
    const { m } = await open()
    await m.type('SVG 源码', 'hello world')
    await m.settle()
    expect(m.text()).toContain('那不是 SVG：根标签里没有 <svg>。')
    expect(m.text()).toContain('还没有可预览的东西')
    m.unmount()
  })

  it('IC-003 选了文件，来源那行念得出文件名，预览出六档', async () => {
    const { m } = await open([['/in/demo.svg']], { '/in/demo.svg': GOOD_SVG })
    await m.press('选 SVG 文件')
    expect(m.text()).toContain('来源：demo.svg')
    for (const size of [15, 16, 32, 64, 128, 256]) expect(m.text()).toContain(`${size}px`)
    m.unmount()
  })

  it('IC-004 取消选择什么都不改', async () => {
    const { m } = await open([null])
    await m.press('选 SVG 文件')
    expect(m.text()).toContain('没选中文件，什么都没改。')
    expect(m.text()).toContain('来源：还没有')
    m.unmount()
  })

  it('IC-005 拖进来那份读不出字节时指回合法来路', async () => {
    const { m } = await open()
    await m.dropFiles('.svg-src', [new File([''], 'empty.svg', { type: 'image/svg+xml' })])
    expect(m.text()).toContain(
      '拖进来的那份读不出字节（这个窗口的 File 对象只是张标签）。请改用「选 SVG 文件」，或把源码贴进下面那个框。'
    )
    m.unmount()
  })

  it('IC-006 有 viewBox 就读它', async () => {
    const { m } = await open()
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    expect(m.text()).toContain('原始比例 24 : 24（来自 viewBox）')
    m.unmount()
  })

  it('IC-007 只有根标签宽高也认，px 后缀也认', async () => {
    const { m } = await open()
    await m.type('SVG 源码', ATTR_SVG)
    await m.settle()
    expect(m.text()).toContain('原始比例 96 : 64（来自根标签的 width/height）')
    m.unmount()
  })

  it('IC-008 两样都没写就按方图并念出来', async () => {
    const { m } = await open()
    await m.type('SVG 源码', BARE_SVG)
    await m.settle()
    expect(m.text()).toContain('这份 SVG 没写 viewBox，也没写数字宽高，按 100 × 100 的方图出。')
    m.unmount()
  })
})

describe('图标工坊的出图', () => {
  it('IC-009 选好落点后，盘上读回来的开头是 PNG 签名', async () => {
    const { fake, m } = await open(['/out/icon.png'])
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    await m.type('PNG 边长', '512')
    await m.press('出 icon.png')

    const written = fake.vol.get('/out/icon.png') as Uint8Array
    expect(Array.from(written.slice(0, 8))).toEqual(PNG_SIGNATURE)
    expect(m.text()).toContain('icon.png 已写到 /out/icon.png')
    expect(raster.calls.at(-1)?.sizes).toEqual([512])
    m.unmount()
  })

  it('IC-010 边长不合范围就不出图', async () => {
    const { fake, m } = await open(['/out/icon.png'])
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    const before = fake.vol.size
    await m.type('PNG 边长', '4')
    await m.press('出 icon.png')

    expect(m.text()).toContain('PNG 边长要在 8 – 1024 px 之间。')
    expect(fake.vol.size).toBe(before)
    expect(raster.calls).toEqual([])
    m.unmount()
  })

  it('IC-011 落点取消就没有文件', async () => {
    const { fake, m } = await open([null])
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    await m.press('出 icon.ico')

    expect(m.text()).toContain('没选落点，文件没写。')
    expect(fake.vol.has('/out/icon.ico')).toBe(false)
    m.unmount()
  })

  it('IC-012 写完之后从盘上读回目录，7 帧升序且每帧 32 位 PNG', async () => {
    const { fake, m } = await open(['/out/icon.ico'])
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    await m.press('出 icon.ico')

    const ico = fake.vol.get('/out/icon.ico') as Uint8Array
    const entries = describeIco(ico)
    expect(frameSizesPhrase(entries)).toBe(ICON_FRAME_SIZES.join('/'))
    expect(entries.every((e) => e.bitCount === 32 && e.png)).toBe(true)
    // 256 那一帧在目录里存 0，读回函数换算回来
    expect(ico[6 + 6 * 16]).toBe(0)
    expect(ico[6 + 6 * 16 + 1]).toBe(0)
    expect(m.text()).toContain('16/24/32/48/64/128/256，每帧 32 位 PNG')
    expect(raster.calls.at(-1)?.sizes).toEqual([...ICON_FRAME_SIZES])
    m.unmount()
  })

  it('IC-013 状态条念得出实际帧清单与大小', async () => {
    const { m } = await open(['/out/icon.ico'])
    await m.type('SVG 源码', GOOD_SVG)
    await m.settle()
    await m.press('出 icon.ico')
    expect(m.text()).toContain('icon.ico 已写到 /out/icon.ico（16/24/32/48/64/128/256，每帧 32 位 PNG，')
    m.unmount()
  })

  it('IC-020 画布交不出像素时念那句原话', async () => {
    const { fake, m } = await open(['/out/icon.png'])
    await m.type('SVG 源码', FOREIGN_SVG)
    await m.settle()
    await m.press('出 icon.png')

    expect(m.text()).toContain(TAINTED)
    expect(fake.vol.has('/out/icon.png')).toBe(false)
    m.unmount()
  })

  it('IC-021 SVG 加载不开时念那句原话', async () => {
    const { m } = await open(['/out/icon.png'])
    await m.type('SVG 源码', UNCLOSED_SVG)
    await m.settle()
    await m.press('出 icon.png')
    expect(m.text()).toContain(BROKEN)
    m.unmount()
  })
})
