// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FakeAirship, mountUi, type Mount } from '@airship/sdk/testing'
import AlbedoApp from '../AlbedoApp.tsx'
import { app } from '../app.ts'
import { STORE_KEY_DOC, STORE_KEY_LANG, STORE_KEY_SOURCE } from '../albedoWorkspace.ts'

/**
 * 位图化替身：jsdom 没有 2D canvas，"PNG 真画得对不对"归 just shot；
 * 这里只记账——交出去的串、宽高与写盘的字节是不是同一回事。
 */
const pngCalls = vi.hoisted(() => [] as Array<{ svg: string; width: number; height: number }>)

vi.mock('../pngExport.ts', () => ({
  svgToPngBytes: async (svg: string, width: number, height: number) => {
    pngCalls.push({ svg, width, height })
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  }
}))

/**
 * AL 册子的影子：每一条断言"界面上读得到哪句话、属性变成什么数"。
 *
 * jsdom 没有 getScreenCTM——指针手势与"手柄大小恒定"这类判据归 `just shot`；
 * 这里的选中走 __ALBEDO_TEST__ 的接缝，断言的全是文字、状态与几何数字。
 * 措辞一律从 hook().t 取——界面和断言念同一份 i18n 真源，改措辞不会两头飘。
 */

type Hooks = {
  load(doc: unknown): void
  doc(): { width: number; height: number; shapes: Array<{ id: string; type: string; name: string }> } | null
  selection(): string[]
  export(): Promise<string | null>
  importSvg(text: string, name?: string): boolean
  tabs(): { left: string; right: string | null }
  setGrid(visible: boolean, size: number): void
  setSnap(on: boolean): void
  snapInfo(): { enabled: boolean; grid: { visible: boolean; size: number }; uiScale: number; threshold: number }
  language(): { mode: string; lang: string }
  setLanguage(mode: 'auto' | 'zh' | 'en'): void
  select(id: string | null): void
  pickIds(indexes: number[]): void
  importUnderlayBytes(bytes: Uint8Array, name: string, mime: string): Promise<void>
  boolean(kind: string): void
  align(mode: string): void
  distribute(axis: string): void
}

function hook(): Hooks {
  return (globalThis as unknown as { __ALBEDO_TEST__: Hooks }).__ALBEDO_TEST__
}

/** 断言失败也不给下一个用例留残树：每个 mount 都登记，afterEach 兜底卸载 */
const liveMounts: Mount[] = []

afterEach(async () => {
  while (liveMounts.length > 0) {
    const m = liveMounts.pop()
    try {
      m?.unmount()
    } catch {
      /* 已经坏了的树，摘不掉就算了 */
    }
  }
})

async function openAlbedo(fake: FakeAirship): Promise<Mount> {
  const m = await mountUi(<AlbedoApp api={fake.api} />, { fake })
  liveMounts.push(m)
  await m.settle()
  await act(async () => hook().setLanguage('zh'))
  await m.settle()
  return m
}

function freshFake(overrides: Partial<{ doc: string }> = {}): FakeAirship {
  const fake = new FakeAirship({
    id: app.id,
    capabilities: app.capabilities,
    theme: { mode: 'light', resolved: 'light' }
  })
  if (overrides.doc) fake.settingsStore[STORE_KEY_DOC] = overrides.doc
  return fake
}

function el(m: Mount, id: string): HTMLElement {
  const found = m.container.querySelector(`#${id}`)
  if (!found) throw new Error(`界面上没有 #${id}`)
  return found as HTMLElement
}

function svgEl(m: Mount, sel: string): Element | null {
  return m.container.querySelector(sel)
}

function toastText(m: Mount): string {
  return el(m, 'toast').textContent ?? ''
}

/** 图层行按界面顺序（第一行 = 最上层）；每次重新查，渲染是整段 innerHTML 重写 */
function layerRows(m: Mount): HTMLElement[] {
  return Array.from(m.container.querySelectorAll<HTMLElement>('.layer-row'))
}

function rowNames(m: Mount): (string | null)[] {
  return layerRows(m).map((r) => r.querySelector('.layer-name')?.textContent ?? null)
}

function toggleOf(m: Mount, visualIndex: number): HTMLButtonElement {
  const btn = layerRows(m)[visualIndex]?.querySelector<HTMLButtonElement>('[data-layer-action="toggle"]')
  if (!btn) throw new Error(`第 ${visualIndex + 1} 行没有眼睛键`)
  return btn
}

/**
 * jsdom 根本没有 DragEvent：手搓一个带 clientY 的冒泡事件。
 * dataTransfer 留空正好——实现里那句 try/catch 会走"状态记在 layerDrag"那条缝。
 */
function dragEvt(type: string, clientY: number): Event {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clientY', { value: clientY })
  return ev
}

/** 等真实定时器走完（保存防抖 320ms / 输入合并 650ms 都不走假定时器） */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

function pngBytes(w: number, h: number): Uint8Array {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  const ihdrLen = [0, 0, 0, 13]
  const dims: number[] = []
  for (const v of [w, h]) dims.push((v >> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255)
  return new Uint8Array([...head, ...ihdrLen, 0x49, 0x48, 0x44, 0x52, ...dims, 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
}

function rectDoc(x: number, y: number, extraShapes = 0): object {
  const shapes = [{ type: 'rect', id: 's_r1', name: '矩形 1', x, y, w: 100, h: 50 }]
  for (let i = 0; i < extraShapes; i += 1) {
    shapes.push({ type: 'ellipse', id: `s_e${i}`, name: `椭圆 ${i + 1}`, cx: 200 + i * 60, cy: 200, rx: 40, ry: 30 })
  }
  return { width: 960, height: 640, shapes }
}

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__ALBEDO_TEST__
})

describe('启动与示例文档', () => {
  it('AL-001 首次启动画布上有三个示例图形', async () => {
    const m = await openAlbedo(freshFake())
    expect(el(m, 'shapeStatus').textContent).toBe('3 个图形')
    expect(el(m, 'layerCount').textContent).toBe('03')
    expect(m.container.querySelector('.layer-row .layer-name')!.textContent).toBe('贝塞尔曲线 1')
    m.unmount()
  })

  it('AL-056 画布没有名字：顶栏读不到名称框，标题栏中段也没被写过', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    hook().load(rectDoc(10, 10))
    await m.settle()
    expect(m.container.querySelector('#docTitle')).toBeNull()
    expect(m.container.querySelector('.topbar')!.textContent).not.toContain('未命名画布')
    expect(fake.windowTitles).toHaveLength(0)
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="rect"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(fake.windowTitles).toHaveLength(0)
    m.unmount()
  })

  it('AL-002 第一次编辑把它落进数据区，重开时保住编辑', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="rect"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await wait(400)
    expect(typeof fake.settingsStore[STORE_KEY_DOC]).toBe('string')
    m.unmount()

    const m2 = await openAlbedo(fake)
    expect(el(m2, 'layerCount').textContent).toBe('04')
    await wait(800)
    expect(el(m2, 'saveState').textContent).toBe('已保存')
    m2.unmount()
  })
})

describe('自动保存', () => {
  it('AL-003 改动之后先念"保存中…"再念"已保存"', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="ellipse"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(el(m, 'saveState').textContent).toBe('保存中…')
    await wait(400)
    expect(el(m, 'saveState').textContent).toBe('已保存')
    m.unmount()
  })

  it('AL-004 保存失败只打灯，不弹窗、不重试', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    await wait(400)
    // 让落盘必炸：settings 键塞一个会让写盘抛错的坏结构（假壳按 JSON 可序列化判）
    const bomb = {
      throws: true,
      set() {
        throw new Error('数据区写不进去')
      }
    }
    const original = fake.api.settings.set
    fake.api.settings.set = ((k: string, v: unknown) => (bomb.throws ? Promise.reject(new Error('写失败')) : original(k, v))) as typeof fake.api.settings.set
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="rect"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await wait(400)
    expect(el(m, 'saveState').textContent).toBe('未保存')
    expect(el(m, 'saveState').classList.contains('error')).toBe(true)
    // 修好之后下一次改动会再试并成功
    fake.api.settings.set = original
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="ellipse"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await wait(400)
    expect(el(m, 'saveState').textContent).toBe('已保存')
    m.unmount()
  })
})

describe('历史', () => {
  it('AL-005 删除可以撤销，撤销有话', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10, 1))
    await m.settle()
    const firstDelete = m.container.querySelector('.layer-row [data-layer-action="delete"]')!
    await act(async () => {
      firstDelete.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('已删除椭圆 1')
    await act(async () => {
      el(m, 'undoBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('已撤销')
    expect(el(m, 'layerCount').textContent).toBe('02')
    m.unmount()
  })

  it('AL-006 没有可撤销时那颗键按不动', async () => {
    const m = await openAlbedo(freshFake())
    expect((el(m, 'undoBtn') as HTMLButtonElement).disabled).toBe(true)
    m.unmount()
  })

  it('AL-007 方向键每按一次是一条历史', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => hook().select('s_r1'))
    await m.settle()
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      })
    }
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('y')).toBe('12')
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        el(m, 'undoBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      await m.settle()
    }
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('y')).toBe('10')
    m.unmount()
  })

  it('AL-008 连续改同一个数字框只产一条历史', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => hook().select('s_r1'))
    await m.settle()
    const w = el(m, 'inspector').querySelector('input[data-prop="w"]')!
    for (const v of ['120', '140', '160']) {
      await act(async () => {
        ;(w as HTMLInputElement).value = v
        w.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await wait(80)
    }
    await wait(800)
    await act(async () => {
      el(m, 'undoBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('width')).toBe('100')
    m.unmount()
  })
})

describe('添加图形', () => {
  it('AL-009 点「矩形」加出第一个矩形', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 960, height: 640, shapes: [] })
    await m.settle()
    await act(async () => hook().pickIds([]))
    await act(async () => {
      const btn = m.container.querySelector('.shape-btn[data-add="rect"]')!
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('已添加矩形 1')
    const rect = svgEl(m, '#shapeLayer rect:not(#canvasBg)')!
    expect(rect.getAttribute('fill')).toBe('#f2c75c')
    expect(el(m, 'layerCount').textContent).toBe('01')
    m.unmount()
  })

  it('AL-010 快捷键只在焦点不在输入框时生效', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => hook().select('s_r1'))
    await m.settle()
    const xInput = el(m, 'inspector').querySelector('input[data-prop="x"]') as HTMLInputElement
    xInput.focus()
    await act(async () => {
      xInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    expect(hook().doc()!.shapes).toHaveLength(1)
    xInput.blur()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', bubbles: true }))
    })
    await m.settle()
    expect(hook().doc()!.shapes).toHaveLength(2)
    m.unmount()
  })
})

describe('路径命令栈', () => {
  async function openStarterPath(m: Mount): Promise<void> {
    const pathShape = hook().doc()!.shapes.find((s) => s.type === 'path')!
    await act(async () => hook().select(pathShape.id))
    await m.settle()
  }

  it('AL-011 起点命令删不掉', async () => {
    const m = await openAlbedo(freshFake())
    await openStarterPath(m)
    const del = el(m, 'inspector').querySelector('.cmd-card .cmd-del') as HTMLButtonElement
    expect(del.disabled).toBe(true)
    expect(del.getAttribute('title')).toBe('起点命令不可删除')
    m.unmount()
  })

  it('AL-012 没有线段时闭合被拒', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 300, height: 300, shapes: [{ type: 'path', id: 'p1', name: '路径 1', commands: [{ type: 'M', x: 10, y: 10 }] }] })
    await m.settle()
    await act(async () => hook().select('p1'))
    await m.settle()
    await act(async () => {
      el(m, 'inspector').querySelector('[data-add-cmd="L"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    // 先删掉刚加的直线（它不是起点，可删）
    const cards = Array.from(el(m, 'inspector').querySelectorAll<HTMLElement>('.cmd-card'))
    await act(async () => {
      cards[cards.length - 1].querySelector('.cmd-del')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await act(async () => {
      el(m, 'inspector').querySelector('[data-add-cmd="Z"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('至少需要一条线段才能闭合')
    m.unmount()
  })

  it('AL-013 闭合过的路径不能再闭合', async () => {
    const m = await openAlbedo(freshFake())
    await openStarterPath(m)
    await act(async () => {
      el(m, 'inspector').querySelector('[data-add-cmd="Z"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await act(async () => {
      el(m, 'inspector').querySelector('[data-add-cmd="Z"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('路径已经闭合')
    m.unmount()
  })

  it('AL-014 命令栈预览与画布用的是同一串', async () => {
    const m = await openAlbedo(freshFake())
    await openStarterPath(m)
    const code = el(m, 'inspector').querySelector('#pathCode')!.textContent ?? ''
    const d = svgEl(m, '#shapeLayer path:not(.shape-hit)')!.getAttribute('d') ?? ''
    expect(code).toBe(d)
    const xInput = el(m, 'inspector').querySelector('input[data-cmd-key="x1"]') as HTMLInputElement
    await act(async () => {
      xInput.value = '333.25'
      xInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await m.settle()
    const code2 = el(m, 'inspector').querySelector('#pathCode')!.textContent ?? ''
    const d2 = svgEl(m, '#shapeLayer path:not(.shape-hit)')!.getAttribute('d') ?? ''
    expect(code2).toBe(d2)
    expect(code2).toContain('333.25')
    m.unmount()
  })

  it('AL-015 复制 path d 进剪贴板', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    await openStarterPath(m)
    await act(async () => {
      el(m, 'inspector').querySelector('[data-copy-path]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(fake.clipboardText).toBe(svgEl(m, '#shapeLayer path:not(.shape-hit)')!.getAttribute('d'))
    expect(toastText(m)).toBe('path d 已复制')
    m.unmount()
  })
})

describe('检查器数值与样式', () => {
  it('AL-016 宽度框改完即画即存', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => hook().select('s_r1'))
    await m.settle()
    const wInp = el(m, 'inspector').querySelector('input[data-prop="w"]') as HTMLInputElement
    await act(async () => {
      wInp.value = '300'
      wInp.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(800)
    await act(async () => {
      el(m, 'inspector').querySelector('input[data-prop="w"]')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    await wait(400)
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('width')).toBe('300')
    const saved = JSON.parse(String(fake.settingsStore[STORE_KEY_DOC]))
    expect(saved.shapes[0].w).toBe(300)
    m.unmount()
  })

  it('AL-017 填充可以置"无"', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => hook().select('s_r1'))
    await m.settle()
    await act(async () => {
      el(m, 'inspector').querySelector('[data-set-none="fill"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('fill')).toBe('none')
    expect(el(m, 'inspector').querySelector('[data-set-none="fill"]')!.classList.contains('active')).toBe(true)
    m.unmount()
  })

  it('AL-018 直线不给填充行', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 400, height: 300, shapes: [{ type: 'line', id: 'l1', name: '直线 1', x1: 10, y1: 10, x2: 90, y2: 80 }] })
    await m.settle()
    await act(async () => hook().select('l1'))
    await m.settle()
    const inspector = el(m, 'inspector')
    expect(inspector.textContent).toContain('描边')
    expect(inspector.querySelector('.color-field [data-set-none="fill"]')).toBeNull()
    const labels = Array.from(inspector.querySelectorAll('.field-label')).map((n) => n.textContent)
    expect(labels).not.toContain('填充')
    m.unmount()
  })

  it('AL-019 多边形改边数按中心重生成', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 400, height: 400, shapes: [{ type: 'polygon', id: 'g1', name: '多边形 1', points: [
      { x: 200, y: 100 }, { x: 290, y: 170 }, { x: 250, y: 280 }, { x: 150, y: 280 }, { x: 110, y: 170 }
    ] }] })
    await m.settle()
    await act(async () => hook().select('g1'))
    await m.settle()
    await m.type('多边形边数', '7')
    await act(async () => {
      el(m, 'inspector').querySelector('[data-poly-sides]')!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('多边形已改为 7 边')
    expect(el(m, 'inspector').querySelectorAll('[data-poly-point]').length / 2).toBe(7)
    m.unmount()
  })
})

describe('图层表', () => {
  it('AL-020 列表第一行是最上层', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 960, height: 640, shapes: [] })
    await m.settle()
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="rect"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await act(async () => {
      m.container.querySelector('.shape-btn[data-add="ellipse"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    const names = Array.from(m.container.querySelectorAll('.layer-name')).map((n) => n.textContent)
    expect(names[0]).toBe('椭圆 1')
    expect(names[1]).toBe('矩形 1')
    m.unmount()
  })

  it('AL-053 拖一行落到另一行下面，两行对调且能撤销', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(0, 0, 1))
    await m.settle()
    expect(rowNames(m)).toEqual(['椭圆 1', '矩形 1'])
    await act(async () => {
      layerRows(m)[0]!.dispatchEvent(dragEvt('dragstart', 0))
    })
    await act(async () => {
      layerRows(m)[1]!.dispatchEvent(dragEvt('drop', 0))
    })
    await m.settle()
    expect(rowNames(m)).toEqual(['矩形 1', '椭圆 1'])
    expect(el(m, 'shapeStatus').textContent).toBe('2 个图形')
    await act(async () => {
      el(m, 'undoBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(rowNames(m)).toEqual(['椭圆 1', '矩形 1'])
    m.unmount()
  })

  it('AL-022 图层行上的删除只删它自己', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(0, 0, 1))
    await m.settle()
    await act(async () => {
      m.container.querySelector('.layer-row [data-layer-action="delete"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('已删除椭圆 1')
    expect(el(m, 'layerCount').textContent).toBe('01')
    m.unmount()
  })

  it('AL-054 隐藏后画布上不画，那颗键改念"显示图层"', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(0, 0, 1))
    await m.settle()
    expect(m.container.querySelectorAll('#shapeLayer .shape')).toHaveLength(2)
    await act(async () => {
      toggleOf(m, 0).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(m.container.querySelectorAll('#shapeLayer .shape')).toHaveLength(1)
    expect(el(m, 'layerCount').textContent).toBe('02')
    expect(el(m, 'shapeStatus').textContent).toBe('2 个图形')
    expect(layerRows(m)[0]!.classList.contains('is-hidden')).toBe(true)
    expect(toggleOf(m, 0).getAttribute('title')).toBe('显示图层')
    await act(async () => {
      toggleOf(m, 0).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(m.container.querySelectorAll('#shapeLayer .shape')).toHaveLength(2)
    expect(toggleOf(m, 0).getAttribute('title')).toBe('隐藏图层')
    m.unmount()
  })

  it('AL-055 隐藏的图形照样进导出，导出串逐字不变', async () => {
    const m = await openAlbedo(freshFake())
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
      '<rect x="10" y="10" width="50" height="40" fill="#abcdef" stroke="#112233" stroke-dasharray="4 2"/>' +
      '</svg>'
    await act(async () => {
      hook().importSvg(svg, '原稿.svg')
    })
    await m.settle()
    const before = await hook().export()
    await act(async () => {
      toggleOf(m, 0).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    const after = await hook().export()
    expect(after).not.toBeNull()
    expect(after).toBe(before)
    expect(after).toContain('stroke-dasharray="4 2"')
    m.unmount()
  })
})

describe('多选、对齐与布尔', () => {
  async function twoRects(m: Mount, x1: number, x2: number): Promise<void> {
    hook().load({
      width: 960,
      height: 640,
      shapes: [
        { type: 'rect', id: 's_a', name: '矩形 1', x: x1, y: 40, w: 60, h: 40, fill: '#f2c75c' },
        { type: 'rect', id: 's_b', name: '矩形 2', x: x2, y: 40, w: 60, h: 40, fill: '#f26b4f' }
      ]
    })
    await m.settle()
    await act(async () => hook().pickIds([0, 1]))
    await m.settle()
  }

  it('AL-023 多选的检查器念得清数量与操作', async () => {
    const m = await openAlbedo(freshFake())
    await twoRects(m, 100, 300)
    expect(el(m, 'inspector').querySelector('.multi-head h1')!.textContent).toBe('2 个图形')
    expect(el(m, 'inspector').querySelectorAll('[data-boolean]').length).toBe(4)
    expect(el(m, 'inspector').querySelectorAll('[data-align]').length).toBe(6)
    m.unmount()
  })

  it('AL-024 左对齐把选区里全部拉到同一条 x', async () => {
    const m = await openAlbedo(freshFake())
    await twoRects(m, 100, 300)
    await act(async () => hook().align('left'))
    await m.settle()
    const xs = Array.from(el(m, 'shapeLayer').querySelectorAll('rect')).map((r) => r.getAttribute('x'))
    expect(new Set(xs).size).toBe(1)
    expect(toastText(m)).toBe('左对齐')
    m.unmount()
  })

  it('AL-025 等距分布少于三个按不动', async () => {
    const m = await openAlbedo(freshFake())
    await twoRects(m, 100, 300)
    const dx = el(m, 'inspector').querySelector('[data-distribute="x"]') as HTMLButtonElement
    const dy = el(m, 'inspector').querySelector('[data-distribute="y"]') as HTMLButtonElement
    expect(dx.disabled).toBe(true)
    expect(dy.disabled).toBe(true)
    m.unmount()
  })

  it('AL-026 交集把两个图形合成一条路径', async () => {
    const m = await openAlbedo(freshFake())
    await twoRects(m, 100, 140)
    await act(async () => hook().boolean('intersect'))
    await m.settle()
    expect(hook().doc()!.shapes).toHaveLength(1)
    expect(hook().doc()!.shapes[0]!.type).toBe('path')
    expect(toastText(m)).toBe('已生成交集')
    // 样式沿用最上层：矩形 2 的填充
    expect(svgEl(m, '#shapeLayer path:not(.shape-hit)')!.getAttribute('fill')).toBe('#f26b4f')
    m.unmount()
  })

  it('AL-027 算不出面积就说算不出', async () => {
    const m = await openAlbedo(freshFake())
    await twoRects(m, 100, 600)
    await act(async () => hook().boolean('intersect'))
    await m.settle()
    expect(toastText(m)).toBe('运算结果为空')
    expect(hook().doc()!.shapes).toHaveLength(2)
    m.unmount()
  })

  it('AL-028 直线不陪布尔玩', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({
      width: 600,
      height: 400,
      shapes: [
        { type: 'rect', id: 's_a', name: '矩形 1', x: 10, y: 10, w: 60, h: 40 },
        { type: 'line', id: 'l1', name: '直线 1', x1: 0, y1: 0, x2: 50, y2: 50 }
      ]
    })
    await m.settle()
    await act(async () => hook().pickIds([0, 1]))
    await m.settle()
    for (const btn of Array.from(el(m, 'inspector').querySelectorAll<HTMLButtonElement>('[data-boolean]'))) {
      expect(btn.disabled).toBe(true)
    }
    m.unmount()
  })
})

describe('导出与复制', () => {
  it('AL-029 导出走系统另存为并把串写进去', async () => {
    const fake = new FakeAirship({
      id: app.id,
      capabilities: app.capabilities,
      picks: ['C:/fake/Downloads/画稿.svg']
    })
    const m = await openAlbedo(fake)
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => {
      el(m, 'exportBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await wait(50)
    const written = [...fake.vol.entries()].find(([path]) => path.replace(/\\/g, '/').endsWith('画稿.svg'))
    expect(written, `卷里应有画稿.svg，实际：${[...fake.vol.keys()].join(', ')}`).toBeTruthy()
    const text = String(written![1])
    expect(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(text).toContain('<rect')
    expect(text).not.toContain('<title>')
    expect(toastText(m)).toBe('SVG 已导出')
    m.unmount()
  })

  it('AL-031 没选字体的文字层拦住导出', async () => {
    const fake = new FakeAirship({ id: app.id, capabilities: app.capabilities, picks: ['never.svg'] })
    const m = await openAlbedo(fake)
    hook().load({ width: 400, height: 300, shapes: [{ type: 'text', id: 't1', name: '文字 1', x: 10, y: 10, text: '你好', fontSize: 40 }] })
    await m.settle()
    await act(async () => {
      el(m, 'exportBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('文字层「文字 1」还没有选择字体，导出前请先指定')
    expect([...fake.vol.keys()].some((k) => k.endsWith('.svg'))).toBe(false)
    m.unmount()
  })

  it('AL-032 复制 SVG 进剪贴板', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => {
      el(m, 'copyBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(fake.clipboardText.startsWith('<?xml')).toBe(true)
    expect(toastText(m)).toBe('SVG 代码已复制')
    m.unmount()
  })

  it('AL-033 画布背景和桌布都不进导出', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 300, height: 300, background: '#00ff00', shapes: [] })
    await m.settle()
    await act(async () => hook().importUnderlayBytes(pngBytes(40, 30), 'ref.png', 'image/png'))
    await m.settle()
    const text = await hook().export()
    expect(text).not.toBeNull()
    expect(text!.toUpperCase()).not.toContain('00FF00')
    expect(text).not.toContain('data:image')
    m.unmount()
  })

  it('AL-034 导入过且没改动的元素原样保留', async () => {
    const m = await openAlbedo(freshFake())
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">' +
      '<rect x="10" y="10" width="50" height="40" fill="#abcdef" stroke="#112233" stroke-dasharray="4 2"/>' +
      '</svg>'
    await act(async () => {
      hook().importSvg(svg, '原稿.svg')
    })
    await m.settle()
    const text = await hook().export()
    expect(text).toContain('stroke-dasharray="4 2"')
    expect(text).toContain('#abcdef')
    m.unmount()
  })

  it('AL-050 导出 PNG 走系统另存为并写出位图字节', async () => {
    pngCalls.length = 0
    const fake = new FakeAirship({
      id: app.id,
      capabilities: app.capabilities,
      picks: ['C:/fake/Downloads/画稿.png']
    })
    const m = await openAlbedo(fake)
    hook().load(rectDoc(10, 10))
    await m.settle()
    await act(async () => {
      el(m, 'exportPngBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await wait(50)
    const written = [...fake.vol.entries()].find(([path]) => path.replace(/\\/g, '/').endsWith('画稿.png'))
    expect(written, `卷里应有画稿.png，实际：${[...fake.vol.keys()].join(', ')}`).toBeTruthy()
    expect(Array.from(written![1] as Uint8Array).slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect(toastText(m)).toBe('PNG 已导出')
    const call = pngCalls[pngCalls.length - 1]!
    expect([call.width, call.height]).toEqual([960, 640])
    expect(call.svg).toContain('<rect')
    m.unmount()
  })

  it('AL-051 没选字体的文字层同样拦住 PNG 导出', async () => {
    pngCalls.length = 0
    const fake = new FakeAirship({ id: app.id, capabilities: app.capabilities, picks: ['never.png'] })
    const m = await openAlbedo(fake)
    hook().load({ width: 400, height: 300, shapes: [{ type: 'text', id: 't1', name: '文字 1', x: 10, y: 10, text: '你好', fontSize: 40 }] })
    await m.settle()
    await act(async () => {
      el(m, 'exportPngBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('文字层「文字 1」还没有选择字体，导出前请先指定')
    expect([...fake.vol.keys()].some((k) => k.endsWith('.png'))).toBe(false)
    expect(pngCalls).toHaveLength(0)
    m.unmount()
  })
})

describe('导入 SVG', () => {
  it('AL-035 导入两个图形并接管文件尺寸', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 960, height: 640, shapes: [] })
    await m.settle()
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="300">' +
      '<rect x="0" y="0" width="100" height="50" fill="#222222"/>' +
      '<path d="M 0 0 L 50 50 Z" fill="#333333"/>' +
      '</svg>'
    await act(async () => {
      hook().importSvg(svg, '图标草稿.svg')
    })
    await m.settle()
    expect(toastText(m)).toBe('已导入 2 个图形')
    expect(el(m, 'canvasSizeLabel').textContent).toBe('500 × 300')
    const names = Array.from(m.container.querySelectorAll('.layer-name')).map((n) => n.textContent)
    expect(names).toContain('图标草稿 1')
    expect(names).toContain('图标草稿 2')
    m.unmount()
  })

  it('AL-036 没有可导入图形的文件不动画布', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 960, height: 640, shapes: [] })
    await m.settle()
    await act(async () => {
      hook().importSvg('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><!--空的--></svg>', '空.svg')
    })
    await m.settle()
    expect(toastText(m)).toBe('SVG 中没有可导入的图形')
    expect(hook().doc()!.shapes).toHaveLength(0)
    m.unmount()
  })

  it('AL-037 渐变被拍平时追加一句', async () => {
    const m = await openAlbedo(freshFake())
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">' +
      '<defs><linearGradient id="g"><stop offset="0" stop-color="#ff0000"/><stop offset="1" stop-color="#00ff00"/></linearGradient></defs>' +
      '<rect x="0" y="0" width="100" height="100" fill="url(#g)"/>' +
      '</svg>'
    await act(async () => {
      hook().importSvg(svg, '渐变.svg')
    })
    await m.settle()
    expect(toastText(m).endsWith(' · 渐变已简化为纯色')).toBe(true)
    m.unmount()
  })

  it('AL-038 解析不了的串有原话', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({ width: 960, height: 640, shapes: [] })
    await m.settle()
    await act(async () => {
      hook().importSvg('这不是 <svg 而是坏掉的 <<<', '坏.svg')
    })
    await m.settle()
    expect(toastText(m)).toBe('SVG 文件无法解析')
    expect(hook().doc()!.shapes).toHaveLength(0)
    m.unmount()
  })
})

describe('桌布', () => {
  it('AL-039 导入桌布即进调整态', async () => {
    const m = await openAlbedo(freshFake())
    await act(async () => hook().importUnderlayBytes(pngBytes(80, 60), 'ref.png', 'image/png'))
    await m.settle()
    expect(svgEl(m, '#underlayLayer image')).not.toBeNull()
    expect(toastText(m)).toBe('桌布已导入 · 拖动调整位置')
    expect(el(m, 'underlayMeta').textContent).toBe('80 × 60 px')
    expect(el(m, 'nodeStatus').textContent).toBe('桌布 · 调整中')
    m.unmount()
  })

  it('AL-040 大图能描但不自动存，只提醒一次', async () => {
    const m = await openAlbedo(freshFake())
    const big = new Uint8Array(2_500_000)
    big.set(pngBytes(10, 10), 0)
    await act(async () => hook().importUnderlayBytes(big, 'big.png', 'image/png'))
    await m.settle()
    expect(toastText(m)).toBe('桌布图片较大，无法自动保存；本次会话内仍可正常描图')
    expect(el(m, 'underlayMeta').textContent).toBe('未自动保存 · 仅本次会话')
    m.unmount()
  })

  it('AL-041 隐藏桌布时调整键按不动', async () => {
    const m = await openAlbedo(freshFake())
    await act(async () => hook().importUnderlayBytes(pngBytes(40, 30), 'ref.png', 'image/png'))
    await m.settle()
    await act(async () => {
      el(m, 'underlayVisibleBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(toastText(m)).toBe('桌布已隐藏')
    expect(svgEl(m, '#underlayLayer image')).toBeNull()
    expect((el(m, 'underlayAdjustBtn') as HTMLButtonElement).disabled).toBe(true)
    m.unmount()
  })

  it('AL-042 桌布不在文档数据里', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    await act(async () => hook().importUnderlayBytes(pngBytes(40, 30), 'ref.png', 'image/png'))
    await wait(450)
    const doc = String(fake.settingsStore[STORE_KEY_DOC] ?? '')
    expect(doc).not.toContain('data:image')
    m.unmount()
  })
})

describe('双语与画布尺寸', () => {
  it('AL-043 切到英文整面话术跟着换', async () => {
    const m = await openAlbedo(freshFake())
    await act(async () => hook().pickIds([]))
    await m.settle()
    expect(el(m, 'exportBtn').textContent).toContain('导出 SVG')
    expect(m.container.querySelector('.empty-inspector h2')!.textContent).toBe('没有选中对象')
    await act(async () => hook().setLanguage('en'))
    await m.settle()
    expect(el(m, 'exportBtn').textContent).toContain('Export SVG')
    expect(m.container.querySelector('.empty-inspector h2')!.textContent).toBe('Nothing selected')
    m.unmount()
  })

  it('AL-044 默认名跟着翻译，自定义名不动', async () => {
    const m = await openAlbedo(freshFake())
    hook().load({
      width: 400,
      height: 400,
      shapes: [
        { type: 'rect', id: 's_1', name: '矩形 1', x: 0, y: 0, w: 40, h: 40 },
        { type: 'rect', id: 's_2', name: '招牌底稿', x: 0, y: 0, w: 40, h: 40 }
      ]
    })
    await m.settle()
    await act(async () => hook().setLanguage('en'))
    await m.settle()
    const names = Array.from(m.container.querySelectorAll('.layer-name')).map((n) => n.textContent)
    expect(names[1]).toBe('Rectangle 1')
    expect(names[0]).toBe('招牌底稿')
    m.unmount()
  })

  it('AL-045 语言选择本身也自动保存', async () => {
    const fake = freshFake()
    const m = await openAlbedo(fake)
    await act(async () => hook().setLanguage('en'))
    await m.settle()
    await act(async () => {
      ;(el(m, 'langSelect') as HTMLSelectElement).value = 'zh'
      el(m, 'langSelect').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await m.settle()
    expect(fake.settingsStore[STORE_KEY_LANG]).toBe('zh')
    await act(async () => {
      ;(el(m, 'langSelect') as HTMLSelectElement).value = 'auto'
      el(m, 'langSelect').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await m.settle()
    expect(fake.settingsStore[STORE_KEY_LANG] ?? null).toBeNull()
    expect(hook().language().mode).toBe('auto')
    m.unmount()
  })

  it('AL-046 空输入与非法值各有各的话', async () => {
    const m = await openAlbedo(freshFake())
    await act(async () => {
      el(m, 'canvasSizeBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await m.type('画布宽度', '')
    await act(async () => {
      el(m, 'canvasApplyBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el(m, 'canvasSizeError').textContent).toBe('请输入画布的宽度和高度。')
    await m.type('画布宽度', '32')
    await act(async () => {
      el(m, 'canvasApplyBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el(m, 'canvasSizeError').textContent).toBe('尺寸需在 64 – 10000 px 之间。')
    m.unmount()
  })

  it('AL-047 应用尺寸只动画布', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(123, 45))
    await m.settle()
    await act(async () => {
      el(m, 'canvasSizeBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    await m.type('画布宽度', '800')
    await m.type('画布高度', '600')
    await act(async () => {
      el(m, 'canvasApplyBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(svgEl(m, '#stage')!.getAttribute('viewBox')).toBe('0 0 800 600')
    expect(toastText(m)).toBe('画布已调整为 800 × 600')
    expect(svgEl(m, '#shapeLayer rect')!.getAttribute('x')).toBe('123')
    m.unmount()
  })

  it('AL-048 开网格后画布上有网', async () => {
    const m = await openAlbedo(freshFake())
    await act(async () => {
      el(m, 'gridToggle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(svgEl(m, '#stageDefs #gridPattern')).not.toBeNull()
    expect(el(m, 'gridLayer').querySelectorAll('rect')).toHaveLength(1)
    await act(async () => {
      el(m, 'gridToggle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(svgEl(m, '#stageDefs #gridPattern')).toBeNull()
    expect(el(m, 'gridLayer').childElementCount).toBe(0)
    m.unmount()
  })

  it('AL-049 吸附开关的状态读得到', async () => {
    const m = await openAlbedo(freshFake())
    expect(el(m, 'snapToggle').getAttribute('aria-pressed')).toBe('true')
    await act(async () => {
      el(m, 'snapToggle').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(el(m, 'snapToggle').getAttribute('aria-pressed')).toBe('false')
    expect(el(m, 'snapToggle').classList.contains('is-active')).toBe(false)
    m.unmount()
  })
})

describe('视口缩放', () => {
  it('AL-052 点「适应屏幕」后标签念按可视区算出的倍率', async () => {
    const m = await openAlbedo(freshFake())
    hook().load(rectDoc(10, 10))
    await m.settle()
    const body = el(m, 'stageBody')
    Object.defineProperty(body, 'clientWidth', { configurable: true, value: 1400 })
    Object.defineProperty(body, 'clientHeight', { configurable: true, value: 900 })
    await act(async () => {
      el(m, 'zoomFitScreenBtn').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await m.settle()
    expect(el(m, 'zoomLabel').textContent).toBe('118%')
    expect(el(m, 'zoomFitScreenBtn').getAttribute('title')).toBe('适应屏幕（Ctrl + 1）')
    m.unmount()
  })
})
