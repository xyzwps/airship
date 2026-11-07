// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi, type Mount } from '@airship/sdk/testing'
import PdfApp from '../PdfApp'
import { loadBooks } from '@airship/library'

/**
 * PD 册子（docs/specs/pdf.md）。
 *
 * pdf.js 在测试里真起不来（没有 worker，jsdom 也没有画布），所以把那一层换成替身：
 * 只交页数与"取一页"，剩下的全是应用自己的代码——续读落点、页码与缩放那一栏、
 * 出图期间的提示、导入时把页数写进这本的附加信息。真出图那条归 `just shot`。
 *
 * 书库与墨读共用同一份索引：断言读的都是 userData/shared/library 里那个文件。
 */

const pdfjs = vi.hoisted(() => ({
  numPages: 3,
  /** 卡住文档加载：用来观察"文档还没到位"时界面念得出什么 */
  holdDoc: false,
  /** 卡住出图：用来观察「渲染中…」那一句 */
  holdRender: false,
  releaseDoc: null as null | (() => void),
  releaseRender: null as null | (() => void)
}))

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => {
    const doc = {
      numPages: pdfjs.numPages,
      getPage: async (): Promise<unknown> => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: Math.round(200 * scale),
          height: Math.round(280 * scale)
        }),
        render: () => ({
          promise: new Promise<void>((resolve) => {
            if (pdfjs.holdRender) pdfjs.releaseRender = resolve
            else resolve()
          })
        })
      }),
      destroy: async (): Promise<void> => undefined
    }
    const promise = new Promise((resolve) => {
      if (pdfjs.holdDoc) pdfjs.releaseDoc = resolve
      else resolve(doc)
    })
    return { promise, destroy: async (): Promise<void> => undefined }
  }
}))

const SHARED = '/fake/userData/shared/library'
const CAPS = ['fs.read', 'fs.write', 'dialog', 'settings', 'shared', 'notify', 'clipboard', 'log'] as const

function shelf(picks?: Array<string[] | string | null>, files?: Record<string, string>): FakeAirship {
  return new FakeAirship({
    id: 'pdf',
    capabilities: [...CAPS],
    sharedNamespaces: ['library'],
    picks,
    files
  })
}

function pdfRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    title: '说明书',
    author: '',
    format: 'pdf',
    file: 'files/p1.pdf',
    cover: null,
    size: 40,
    addedAt: '2026-11-01T00:00:00.000Z',
    progress: null,
    meta: { pages: 3 },
    ...over
  }
}

function seedLibrary(fake: FakeAirship, books: unknown[]): void {
  fake.seed(`${SHARED}/library.json`, `${JSON.stringify({ version: 2, books }, null, 2)}\n`)
  fake.seed(`${SHARED}/files/p1.pdf`, '%PDF-1.4 一份说明书')
}

/** jsdom 的画布既画不出图也不会回回调，导入封面这一步由用例代管 */
function stubCanvas(what: () => Blob | null): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb: (b: Blob | null) => void) => {
    cb(what())
  })
}

async function mount(fake: FakeAirship, confirm = true): Promise<Mount> {
  return mountUi(<PdfApp api={fake.api} />, { fake, confirm })
}

/** 直接进阅读界面：书架上点那份说明书 */
async function opened(progress: unknown = null): Promise<Mount> {
  const fake = shelf()
  seedLibrary(fake, [pdfRecord({ progress })])
  const m = await mount(fake)
  await m.press('说明书')
  return m
}

afterEach(() => {
  pdfjs.numPages = 3
  pdfjs.holdDoc = false
  pdfjs.holdRender = false
  pdfjs.releaseDoc = null
  pdfjs.releaseRender = null
  vi.restoreAllMocks()
})

describe('书架上只列 PDF，但那份书是共用的', () => {
  it('PD-001 顶上是「PDF」那句说明，列表里只有 PDF', async () => {
    const fake = shelf()
    seedLibrary(fake, [
      pdfRecord(),
      pdfRecord({ id: 'b1', title: '一本电子书', format: 'epub', file: 'files/b1.epub', meta: {} })
    ])
    const m = await mount(fake)
    expect(m.text()).toContain('与墨读共用同一个书架，这里只列 PDF')
    expect(m.text()).toContain('说明书')
    expect(m.has('一本电子书')).toBe(false)
    m.unmount()
  })

  it('PD-002 书库里没有 PDF 时读得到那句空态', async () => {
    const fake = shelf()
    seedLibrary(fake, [pdfRecord({ id: 'b1', title: '一本电子书', format: 'epub', file: 'files/b1.epub' })])
    const m = await mount(fake)
    expect(m.text()).toContain('还没有 PDF。点右上角导入一份。')
    m.unmount()
  })

  it('PD-003 每行念得出标题、页数与读到第几页', async () => {
    const fake = shelf()
    seedLibrary(fake, [pdfRecord({ progress: { section: 1, fraction: 0, cfi: null, updatedAt: '2026-11-02T00:00:00.000Z' } })])
    const m = await mount(fake)
    expect(m.text()).toContain('3 页')
    expect(m.text()).toContain('读到第 2 页')
    m.unmount()
  })

  it('PD-004 移除要先确认，不确认就什么都不动', async () => {
    const fake = shelf()
    seedLibrary(fake, [pdfRecord(), pdfRecord({ id: 'p2', title: '另一份', file: 'files/p2.pdf' })])
    const m = await mount(fake, false)
    let asked = ''
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      asked = message ?? ''
      return false
    })
    await m.press('移除')

    expect(asked).toBe('从书架移除《说明书》？本地副本和封面会一起删掉。')
    expect(m.has('说明书')).toBe(true)
    expect((await loadBooks(fake.api)).map((b) => b.id)).toEqual(['p1', 'p2'])
    expect(fake.vol.has(`${SHARED}/files/p1.pdf`)).toBe(true)
    m.unmount()
  })

  it('PD-005 确认移除后索引与文件一起没了，别的不动', async () => {
    const fake = shelf()
    seedLibrary(fake, [pdfRecord({ cover: 'covers/p1.jpg' }), pdfRecord({ id: 'p2', title: '另一份', file: 'files/p2.pdf' })])
    fake.seed(`${SHARED}/covers/p1.jpg`, 'JPG')
    fake.seed(`${SHARED}/files/p2.pdf`, '另一份')
    const m = await mount(fake, true)
    await m.press('移除')

    expect((await loadBooks(fake.api)).map((b) => b.id)).toEqual(['p2'])
    expect(fake.vol.has(`${SHARED}/files/p1.pdf`)).toBe(false)
    expect(fake.vol.has(`${SHARED}/covers/p1.jpg`)).toBe(false)
    expect(fake.vol.has(`${SHARED}/files/p2.pdf`)).toBe(true)
    m.unmount()
  })

  it('PD-006 导入的标题取自文件名，页数与封面都落到共用索引里', async () => {
    stubCanvas(() => new Blob(['封面字节'], { type: 'image/jpeg' }))
    const fake = shelf([['/fake/desktop/年度报告.pdf']], { '/fake/desktop/年度报告.pdf': '%PDF-1.4 一份报告' })
    const m = await mount(fake)
    await m.press('导入 PDF')

    const [book] = await loadBooks(fake.api)
    expect(book!.title).toBe('年度报告')
    expect(book!.format).toBe('pdf')
    expect(book!.meta).toEqual({ pages: 3 })
    expect(book!.cover).toBe(`covers/${book!.id}.jpg`)
    expect(fake.vol.has(`${SHARED}/files/${book!.id}.pdf`)).toBe(true)
    expect(fake.text(`${SHARED}/covers/${book!.id}.jpg`)).toBe('封面字节')
    expect(m.text()).toContain('3 页')
    m.unmount()
  })

  it('PD-007 封面渲不出来也不挡导入', async () => {
    // jsdom 的画布画不出图：让这一步直接失败
    stubCanvas(() => {
      throw new Error('画布画不出图')
    })
    const fake = shelf([['/fake/desktop/没封面.pdf']], { '/fake/desktop/没封面.pdf': '%PDF-1.4 内容' })
    const m = await mount(fake)
    await m.press('导入 PDF')

    const [book] = await loadBooks(fake.api)
    expect(book!.title).toBe('没封面')
    expect(book!.cover).toBeNull()
    expect(book!.meta).toEqual({ pages: 3 })
    expect(m.has('没封面')).toBe(true)
    m.unmount()
  })
})

describe('阅读界面那一栏只有必需的几个动作', () => {
  it('PD-008 顶栏那颗「← 书架」回书架，并重新读到最新进度', async () => {
    const m = await opened()
    expect(m.text()).toContain('← 书架')
    await m.press('下一页')
    await m.press('← 书架')
    expect(m.text()).toContain('导入 PDF')
    expect(m.text()).toContain('读到第 2 页')
    m.unmount()
  })

  it('PD-009 页码那一格念得出当前与总数，文档还没到位时总数也在', async () => {
    pdfjs.holdDoc = true
    const m = await opened()
    // 文档还压着没到位：总数用的是索引里登记的页数
    expect(m.text()).toContain('1 / 3')
    await m.key('ArrowRight', m.container.querySelector('.pdf-reader__scroll') as HTMLElement)
    // 这时按一键也夹在同一总数上，不会翻出个第 0 页
    expect(m.text()).toContain('2 / 3')
    expect(m.text()).not.toContain('0 /')
    await act(async () => {
      pdfjs.releaseDoc?.()
    })
    await m.settle()
    expect(m.text()).toContain('2 / 3')
    m.unmount()
  })

  it('PD-010 第一页时上一页点不动，最后一页时下一页点不动', async () => {
    const m = await opened()
    expect(m.byText('上一页').disabled).toBe(true)
    expect(m.byText('下一页').disabled).toBe(false)
    await m.press('下一页')
    await m.press('下一页')
    expect(m.text()).toContain('3 / 3')
    expect(m.byText('下一页').disabled).toBe(true)
    m.unmount()
  })

  it('PD-011 键盘向右翻页，向左退回去，两头都夹住', async () => {
    const m = await opened()
    const target = m.container.querySelector('.pdf-reader__scroll') as HTMLElement
    await m.key('ArrowRight', target)
    expect(m.text()).toContain('2 / 3')
    await m.key('ArrowRight', target)
    await m.key('ArrowRight', target)
    expect(m.text()).toContain('3 / 3')
    await m.key('ArrowLeft', target)
    expect(m.text()).toContain('2 / 3')
    await m.key('PageUp', target)
    expect(m.text()).toContain('1 / 3')
    await m.key('PageUp', target)
    expect(m.text()).toContain('1 / 3')
    m.unmount()
  })

  it('PD-012 翻一页就把这一页写回共用的那本索引', async () => {
    const m = await opened()
    const fake = m.fake!
    await m.press('下一页')
    const [book] = await loadBooks(fake.api)
    expect(book!.progress?.section).toBe(1)
    expect(book!.progress?.fraction).toBe(0)
    expect(book!.progress?.cfi).toBeNull()
    expect(typeof book!.progress?.updatedAt).toBe('string')

    // 墨读那边读的是同一份索引
    const reader = new FakeAirship({ id: 'books', capabilities: [...CAPS], sharedNamespaces: ['library'] })
    for (const [p, c] of fake.vol) reader.vol.set(p, c)
    expect((await loadBooks(reader.api))[0]!.progress?.section).toBe(1)
    m.unmount()
  })

  it('PD-013 再打开时落在上次读到的那一页', async () => {
    const m = await opened({ section: 2, fraction: 0, cfi: null, updatedAt: '2026-11-03T00:00:00.000Z' })
    expect(m.text()).toContain('3 / 3')
    expect(m.byText('下一页').disabled).toBe(true)
    m.unmount()
  })

  it('PD-014 缩放一档 25%，从 125% 起，两头都有界', async () => {
    const m = await opened()
    expect(m.text()).toContain('125%')
    await m.press('＋')
    expect(m.text()).toContain('150%')
    await m.press('−')
    await m.press('−')
    await m.press('−')
    await m.press('−')
    expect(m.text()).toContain('50%')
    expect(m.byText('−').disabled).toBe(true)

    const up = await opened()
    for (let i = 0; i < 14; i++) await up.press('＋')
    expect(up.text()).toContain('400%')
    expect(up.byText('＋').disabled).toBe(true)
    up.unmount()
    m.unmount()
  })

  it('PD-015 缩放不进设置，换一次重开回到 125%', async () => {
    const fake = shelf()
    seedLibrary(fake, [pdfRecord()])
    const m = await mount(fake)
    await m.press('说明书')
    await m.press('＋')
    expect(m.text()).toContain('150%')
    expect(fake.settingsLog).toEqual([])
    m.unmount()

    const again = await mountUi(<PdfApp api={fake.api} />, { fake })
    await again.press('说明书')
    expect(again.text()).toContain('125%')
    again.unmount()
  })

  it('PD-016 出图那会儿读得到「渲染中…」，出完就没了', async () => {
    pdfjs.holdRender = true
    const m = await opened()
    expect(m.text()).toContain('渲染中…')
    await act(async () => {
      pdfjs.releaseRender?.()
    })
    await m.settle()
    expect(m.has('渲染中…')).toBe(false)
    m.unmount()
  })
})
