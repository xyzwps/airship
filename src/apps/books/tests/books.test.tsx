// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FakeAirship } from '@tests/helpers/fakeAirship'
import { mountUi, type Mount } from '@tests/helpers/mount'
import BooksApp from '@apps/books/BooksApp'
import { loadBooks } from '@shared/library'

/**
 * BK 册子（docs/specs/books.md）。
 *
 * 渲染库（foliate-js）在测试里真跑不起来，所以整个换成替身：
 * 替身只记"我们的代码交出去的是什么、翻了几页、跳到哪"，
 * 排版产物、目录、字号、进度落盘、键位与滚轮这些判据都落在我们自己的代码上。
 * 真书渲染的观感归 `just shot`。
 *
 */

interface Recorder {
  opened: unknown[]
  nextCalls: number
  prevCalls: number
  goTo: unknown[]
  styles: Array<Record<string, string>>
  index: number
}

const foliate = vi.hoisted(() => ({
  views: [] as Recorder[],
  /** 名字里含这段字样的书，元数据读不出来 */
  fails: '',
  /** 替身「解析」出来的目录与节数：真解析在渲染库里，这里只给我们这条链要用的形状 */
  toc: [{ label: '第一章 起风了', href: '0' }, { label: '第二章 河上的船', href: '1' }] as Array<{
    label: string
    href: string
  }>,
  sections: 2,
  meta: { title: '书里的标题', author: '书里的作者' },
  cover: 'image/png'
}))

vi.mock('foliate-js/view.js', () => {
  class FakeView extends HTMLElement {
    book: Record<string, unknown> | null = null
    lastLocation: { cfi: string | null } = { cfi: null }
    rec: Recorder = { opened: [], nextCalls: 0, prevCalls: 0, goTo: [], styles: [], index: 0 }
    relocateHandler: ((e: { detail: unknown }) => void) | null = null
    loadHandlers: Array<(e: unknown) => void> = []

    renderer = {
      setStyles: (styles: Record<string, string>): void => {
        this.rec.styles.push(styles)
      },
      addEventListener: (type: string, fn: (e: { detail: unknown }) => void): void => {
        if (type === 'relocate') this.relocateHandler = fn
      },
      getContents: () => [{ doc: document }]
    }

    constructor() {
      super()
      foliate.views.push(this.rec)
    }

    addEventListener(type: string, fn: (e: unknown) => void): void {
      if (type === 'load') this.loadHandlers.push(fn)
    }

    async open(book: unknown): Promise<void> {
      this.rec.opened.push(book)
      // 交出去的东西原样记下来（BK-024 判的就是它）；同时替渲染库「解析」出一本书的形状，
      // 因为节数与目录是阅读器要用的
      this.book = {
        ...(book as Record<string, unknown>),
        sections: Array.from({ length: foliate.sections }, (_, i) => ({ id: String(i) })),
        toc: foliate.toc,
        metadata: foliate.meta
      }
      // 节文档到位：我们的代码要在这里把键位绑上
      for (const fn of this.loadHandlers) fn({ detail: { doc: document } })
    }

    move(step: number): void {
      this.rec.index += step
      this.lastLocation = { cfi: `html/${this.rec.index}` }
      this.relocateHandler?.({ detail: { index: this.rec.index, fraction: 0 } })
    }

    next(): void {
      this.rec.nextCalls += 1
      this.move(1)
    }

    prev(): void {
      this.rec.prevCalls += 1
      this.move(-1)
    }

    goTo(target: unknown): void {
      this.rec.goTo.push(target)
    }

    goToFraction(): void {}

    close(): void {}
  }

  if (!customElements.get('foliate-view')) customElements.define('foliate-view', FakeView)

  return {
    makeBook: async (file: { name: string }) => {
      if (foliate.fails && file.name.includes(foliate.fails)) throw new Error('这本的元数据读不出来')
      return {
        metadata: foliate.meta,
        getCover: async () => (foliate.cover ? new Blob(['封面字节'], { type: foliate.cover }) : null)
      }
    }
  }
})

const SHARED = '/fake/userData/shared/library'
const CAPS = ['fs.read', 'fs.write', 'dialog', 'settings', 'shared', 'notify', 'clipboard', 'log'] as const

function shelf(picks?: Array<string[] | string | null>, files?: Record<string, string>): FakeAirship {
  return new FakeAirship({
    id: 'books',
    capabilities: [...CAPS],
    sharedNamespaces: ['library'],
    picks,
    files
  })
}

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'b1',
    title: '起风了',
    author: '堀辰雄',
    format: 'epub',
    file: 'files/b1.epub',
    cover: null,
    size: 60,
    addedAt: '2026-11-01T00:00:00.000Z',
    progress: null,
    meta: {},
    ...over
  }
}

const BOOK_BODY = '第一章 起风了\n风从河面上过来。\n\n第二章 河上的船\n船是半夜来的。'

function seed(fake: FakeAirship, books: unknown[], files: Record<string, string> = {}): void {
  fake.seed(`${SHARED}/library.json`, `${JSON.stringify({ version: 2, books }, null, 2)}\n`)
  for (const [name, body] of Object.entries(files)) fake.seed(`${SHARED}/${name}`, body)
}

async function mount(fake: FakeAirship, confirm?: boolean): Promise<Mount> {
  return mountUi(<BooksApp api={fake.api} />, { fake, confirm })
}

/** 共享区里就一本 EPUB 的状态 */
function bookShelf(progress: unknown = null): FakeAirship {
  const fake = shelf()
  seed(fake, [record({ progress })], { 'files/b1.epub': BOOK_BODY })
  return fake
}

/** 从书架点进一本：返回界面与这一本对应的渲染库替身 */
async function openBook(title: string, fake = bookShelf()): Promise<{ m: Mount; rec: Recorder }> {
  const m = await mount(fake)
  await m.press(title)
  const rec = foliate.views[foliate.views.length - 1]!
  await m.settle()
  return { m, rec }
}

function lastRec(): Recorder {
  return foliate.views[foliate.views.length - 1]!
}

beforeEach(() => {
  foliate.views = []
  foliate.fails = ''
  foliate.meta = { title: '书里的标题', author: '书里的作者' }
  foliate.cover = 'image/png'
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('书架只列自家格式，但那份书是共用的', () => {
  it('BK-001 顶部是「墨读」与那句说明', async () => {
    const fake = shelf()
    seed(fake, [])
    const m = await mount(fake)
    expect(m.text()).toContain('墨读')
    expect(m.text()).toContain('EPUB / MOBI，与 PDF 应用共用同一个书架')
    expect(m.text()).toContain('导入书籍')
    m.unmount()
  })

  it('BK-002 书架空着时读得到那句空态', async () => {
    const fake = shelf()
    seed(fake, [])
    const m = await mount(fake)
    expect(m.text()).toContain('书架是空的。点右上角导入一本试试。')
    m.unmount()
  })

  it('BK-003 同一份索引里的 PDF 不进墨读的书架', async () => {
    const fake = shelf()
    seed(fake, [record(), record({ id: 'p1', title: '一份说明书', format: 'pdf', file: 'files/p1.pdf' })])
    const m = await mount(fake)
    expect(m.text()).toContain('起风了')
    expect(m.has('一份说明书')).toBe(false)
    expect((await loadBooks(fake.api)).length).toBe(2)
    m.unmount()
  })

  it('BK-004 卡片念得出标题与作者，没作者时念格式，没封面时用标题头几个字占位', async () => {
    const fake = shelf()
    seed(fake, [
      record(),
      record({ id: 'b2', title: '河上的船', author: '', file: 'files/b2.epub' })
    ])
    const m = await mount(fake)
    expect(m.text()).toContain('堀辰雄')
    expect(m.text()).toContain('河上的船')
    expect(m.allByText('EPUB').length).toBe(1)
    expect(m.container.querySelectorAll('.book-card__no-cover').length).toBe(2)
    m.unmount()
  })

  it('BK-005 移除要先确认，答"否"就什么都不动', async () => {
    const fake = shelf()
    seed(fake, [record()], { 'files/b1.epub': BOOK_BODY })
    let asked = ''
    vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      asked = message ?? ''
      return false
    })
    const m = await mount(fake)
    await m.press('移除')
    expect(asked).toBe('从书架移除《起风了》？本地副本和封面会一起删掉。')
    expect(m.has('起风了')).toBe(true)
    expect(fake.vol.has(`${SHARED}/files/b1.epub`)).toBe(true)
    expect((await loadBooks(fake.api)).length).toBe(1)
    m.unmount()
  })

  it('BK-006 确认移除后索引与文件一起没了', async () => {
    const fake = shelf()
    seed(fake, [record({ cover: 'covers/b1.jpg' })], {
      'files/b1.epub': BOOK_BODY,
      'covers/b1.jpg': 'JPG'
    })
    const m = await mount(fake, true)
    await m.press('移除')

    expect((await loadBooks(fake.api)).length).toBe(0)
    expect(fake.vol.has(`${SHARED}/files/b1.epub`)).toBe(false)
    expect(fake.vol.has(`${SHARED}/covers/b1.jpg`)).toBe(false)
    expect(m.text()).toContain('书架是空的。点右上角导入一本试试。')
    m.unmount()
  })
})

describe('导入把元数据交给书库，读不出来就退化成文件名', () => {
  it('BK-007 导入 MOBI：格式记 mobi，本体落进共享区的 files/ 下', async () => {
    const fake = shelf([['/fake/media/起风了.mobi']], { '/fake/media/起风了.mobi': BOOK_BODY })
    const m = await mount(fake)
    await m.press('导入书籍')

    const [book] = await loadBooks(fake.api)
    expect(book!.format).toBe('mobi')
    expect(fake.vol.has(`${SHARED}/files/${book!.id}.mobi`)).toBe(true)
    expect(book!.title).toBe('书里的标题')
    expect(m.text()).toContain('书里的标题')
    m.unmount()
  })

  it('BK-008 导入 EPUB：标题、作者与封面都取自书自己', async () => {
    const fake = shelf([['/fake/media/封面书.epub']], { '/fake/media/封面书.epub': 'PK 一份电子书' })
    const m = await mount(fake)
    await m.press('导入书籍')

    const [book] = await loadBooks(fake.api)
    expect(book!.title).toBe('书里的标题')
    expect(book!.author).toBe('书里的作者')
    expect(book!.cover).toBe(`covers/${book!.id}.png`)
    expect(fake.text(`${SHARED}/covers/${book!.id}.png`)).toBe('封面字节')
    // 卡片上真画出了一张封面图：地址必须是应用窗口 CSP 放行图片来源（blob:），
    // 内容就是上面断言过的那个共享区文件
    const img = m.container.querySelector('.book-card__cover img') as HTMLImageElement
    expect(img.src.startsWith('blob:'), `封面地址用的是别的来源：${img.src}`).toBe(true)
    m.unmount()
  })

  it('BK-009 读不出元数据的那本照样导入，用文件名当标题', async () => {
    foliate.fails = '坏书'
    const fake = shelf([['/fake/media/坏书.epub']], { '/fake/media/坏书.epub': '读不懂的字节' })
    const m = await mount(fake)
    await m.press('导入书籍')

    const [book] = await loadBooks(fake.api)
    expect(book!.title).toBe('坏书')
    expect(book!.author).toBe('')
    expect(book!.cover).toBeNull()
    expect(m.has('坏书')).toBe(true)
    expect(m.text()).not.toContain('导入失败')
    m.unmount()
  })

  it('BK-010 同一本再导一次不增多', async () => {
    const body = '一本很短的书\n正文'
    const fake = shelf([['/fake/media/重复.epub'], ['/fake/media/副本.epub']], {
      '/fake/media/重复.epub': body,
      '/fake/media/副本.epub': body + '——另一本，字节数不一样'
    })
    const m = await mount(fake)
    await m.press('导入书籍')
    await m.press('导入书籍')

    // 两本内容不同 → 两本；同一个文件再导一次不增多（判重认的是大小与标题）
    expect((await loadBooks(fake.api)).length).toBe(2)

    const again = shelf([['/fake/media/重复.epub']], { '/fake/media/重复.epub': body })
    const m2 = await mount(again)
    await m2.press('导入书籍')
    await m2.press('导入书籍')
    expect((await loadBooks(again.api)).length).toBe(1)
    m.unmount()
    m2.unmount()
  })
})

describe('阅读界面那一栏与字号', () => {
  function reader(progress: unknown = null): Promise<Mount> {
    const fake = shelf()
    fake.seed(`${SHARED}/library.json`, `${JSON.stringify({ version: 2, books: [record({ progress })] }, null, 2)}\n`)
    fake.seed(`${SHARED}/files/b1.epub`, BOOK_BODY)
    return mountUi(<BooksApp api={fake.api} />, { fake })
  }

  it('BK-016 顶栏那颗回书架的图标键点了就回书架', async () => {
    const m = await reader()
    await m.press('起风了')
    const back = m.field('回书架')
    expect(back, '顶栏该有一颗回书架的图标键').not.toBeNull()
    // 纯图标键：悬停说明与无障碍名称都得说话
    expect(back!.getAttribute('title')).toBe('返回书架')
    expect(back!.getAttribute('aria-label')).toBe('返回书架')
    await m.pressIn('.icon-btn')
    expect(m.text()).toContain('导入书籍')
    m.unmount()
  })

  it('BK-031 顶栏没有翻页键', async () => {
    const m = await reader()
    await m.press('起风了')
    expect(m.text()).not.toContain('上一页')
    expect(m.text()).not.toContain('下一页')
    // 剩下的都是必需项
    expect(m.field('回书架')).not.toBeNull()
    expect(m.text()).toContain('目录')
    expect(m.text()).toContain('A＋')
    m.unmount()
  })

  it('BK-017 书名交给标题栏中段，底栏念得出读到哪一节与全书进度', async () => {
    const fake = shelf()
    fake.seed(`${SHARED}/library.json`, `${JSON.stringify({ version: 2, books: [record({ progress: null })] }, null, 2)}
`)
    fake.seed(`${SHARED}/files/b1.epub`, BOOK_BODY)
    const m = await mountUi(<BooksApp api={fake.api} />, { fake })
    await m.press('起风了')
    await m.settle()

    // 书名与作者交给标题栏中段（应用窗口里由宿主画出来，见 SH-019）
    expect(fake.windowTitles.at(-1)).toBe('起风了 · 堀辰雄')
    // 工具条上不再重复一份书名
    expect(m.container.querySelector('.books-reader__title')).toBeNull()

    // 底栏：第几节 / 共几节 + 全书百分比
    const hint = m.container.querySelector('.books-reader__hint')!.textContent!.replace(/\s+/g, ' ')
    expect(hint).toContain('第 1 / 2 节')
    expect(hint).toMatch(/约 \d+%/)

    await m.pressIn('.icon-btn')
    await m.settle()
    expect(fake.windowTitles.at(-1)).toBeNull()
    m.unmount()
  })

  it('BK-018 字号一档 10%，到 140% 与 80% 那半边就禁用', async () => {
    const m = await reader()
    await m.press('起风了')
    expect(m.text()).toContain('100%')
    await m.press('A＋')
    expect(m.text()).toContain('110%')
    for (let i = 0; i < 5; i++) await m.press('A＋')
    expect(m.text()).toContain('140%')
    expect(m.byText('A＋').disabled).toBe(true)

    for (let i = 0; i < 10; i++) await m.press('A−')
    expect(m.text()).toContain('80%')
    expect(m.byText('A−').disabled).toBe(true)
    m.unmount()
  })

  it('BK-019 字号改动立刻进设置，重开还是那个值', async () => {
    const fake = shelf()
    fake.seed(`${SHARED}/library.json`, `${JSON.stringify({ version: 2, books: [record()] }, null, 2)}\n`)
    fake.seed(`${SHARED}/files/b1.epub`, BOOK_BODY)
    const m = await mountUi(<BooksApp api={fake.api} />, { fake })
    await m.press('起风了')
    await m.press('A＋')
    await m.press('A＋')
    expect(m.text()).toContain('120%')
    expect(fake.settingsStore['prefs']).toEqual({ fontScale: 1.2 })
    m.unmount()

    const again = await mountUi(<BooksApp api={fake.api} />, { fake })
    await again.press('起风了')
    expect(again.text()).toContain('120%')
    again.unmount()
  })

  it('BK-020 有章时目录那颗带条数，点开出得了章名，点一章跳过去', async () => {
    const { m, rec } = await openBook('起风了')
    expect(m.text()).toContain('目录 2')
    await m.press('目录')
    expect(m.text()).toContain('第一章 起风了')
    expect(m.text()).toContain('第二章 河上的船')
    await m.press('第二章 河上的船')
    // 打开时先去过一次上次的位置，这一次跳的是点的那一章
    expect(rec.goTo[rec.goTo.length - 1]).toBe('1')
    // 跳完就把目录收起来
    expect(m.has('第一章 起风了')).toBe(false)
    m.unmount()
  })

  it('BK-021 还没读出章的时候目录那颗点不动', async () => {
    foliate.toc = []
    const fake = shelf()
    fake.seed(
      `${SHARED}/library.json`,
      `${JSON.stringify({ version: 2, books: [record({ id: 'e1', title: '一本EPUB', format: 'epub', file: 'files/e1.epub' })] }, null, 2)}\n`
    )
    fake.seed(`${SHARED}/files/e1.epub`, 'PK 一份电子书')
    const m = await mount(fake)
    await m.press('一本EPUB')
    expect(m.byText('目录').disabled).toBe(true)
    foliate.toc = [{ label: '第一章 起风了', href: '0' }, { label: '第二章 河上的船', href: '1' }]
    m.unmount()
  })
})

describe('交出去的是按范围取字节的文件', () => {
  it('BK-024 打开 EPUB 时交出去的是一个按范围取字节的文件，不是整本内容', async () => {
    const fake = shelf()
    const bytes = 'PK' + 'x'.repeat(118)
    fake.seed(
      `${SHARED}/library.json`,
      `${JSON.stringify({ version: 2, books: [record({ id: 'e1', title: '一本EPUB', format: 'epub', file: 'files/e1.epub', size: bytes.length })] }, null, 2)}\n`
    )
    fake.seed(`${SHARED}/files/e1.epub`, bytes)
    const m = await mount(fake)
    await m.press('一本EPUB')
    await m.settle()

    const file = lastRec().opened[0] as { name: string; size: number; slice(from?: number, to?: number): { arrayBuffer(): Promise<ArrayBuffer> } }
    expect(file.name).toBe('一本EPUB')
    expect(file.size).toBe(bytes.length)
    // 只取头四个字节也拿得到，靠的是壳的范围读
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
    expect(new TextDecoder().decode(head)).toBe('PKxx')
    m.unmount()
  })

  it('BK-025 没有封面时书架卡片用标题头几个字占位，读到封面地址时才画图', async () => {
    const fake = shelf()
    seed(fake, [record({ cover: 'covers/b1.jpg' })], { 'covers/b1.jpg': 'JPG' })
    const m = await mount(fake)
    const img = m.container.querySelector('.book-card__cover img') as HTMLImageElement
    expect(img.src.startsWith('blob:')).toBe(true)
    m.unmount()

    const bare = shelf()
    seed(bare, [record()])
    const m2 = await mount(bare)
    expect(m2.container.querySelector('.book-card__cover img')).toBeNull()
    expect(m2.container.querySelector('.book-card__no-cover')?.textContent).toBe('起风了')
    m2.unmount()
  })
})

describe('续读落在上次的位置，翻页写回共用索引', () => {
  it('BK-026 上次留有 CFI 就交那串 CFI，没有才交节号', async () => {
    const withCfi = await openBook('起风了', bookShelf({ section: 4, fraction: 0.5, cfi: 'epubcfi(/6/12!)', updatedAt: '2026-11-03T00:00:00.000Z' }))
    expect(withCfi.rec.goTo).toEqual(['epubcfi(/6/12!)'])
    withCfi.m.unmount()

    const noCfi = await openBook('起风了', bookShelf({ section: 1, fraction: 0, cfi: null, updatedAt: '2026-11-03T00:00:00.000Z' }))
    expect(noCfi.rec.goTo).toEqual([1])
    noCfi.m.unmount()
  })

  it('BK-027 翻过一页再回书架，进度已经写进共用索引', async () => {
    const fake = shelf()
    seed(fake, [record()], { 'files/b1.epub': BOOK_BODY })
    const m = await mount(fake)
    await m.press('起风了')
    await m.key('ArrowRight')
    await m.pressIn('.icon-btn')  // 回书架那颗是纯图标键

    const [book] = await loadBooks(fake.api)
    expect(book!.progress?.section).toBe(1)
    expect(book!.progress?.cfi).toBe('html/1')
    m.unmount()
  })
})

describe('翻页输入', () => {
  it('BK-028 方向键向右翻一页、向左退一页，空格也算向右', async () => {
    const { m, rec } = await openBook('起风了')
    await m.key('ArrowRight')
    expect(rec.nextCalls).toBe(1)
    await m.key('ArrowLeft')
    expect(rec.prevCalls).toBe(1)
    await m.key(' ')
    expect(rec.nextCalls).toBe(2)
    // 按住 Ctrl 的组合键不算翻页
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', ctrlKey: true, bubbles: true }))
    })
    expect(rec.nextCalls).toBe(2)
    m.unmount()
  })

  it('BK-029 滚轮不到一档不翻页，够一档翻一页', async () => {
    const { m, rec } = await openBook('起风了')
    const wheel = (deltaY: number): Promise<void> =>
      act(async () => {
        document.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }))
      })
    await wheel(40)
    expect(rec.nextCalls).toBe(0)
    await wheel(110)
    // 滚轮是每 220ms 排一次额度：等真时间过去，别用 settle() 的空转（负载高时会偶发红）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 260))
    })
    expect(rec.nextCalls).toBe(1)
    m.unmount()
  })

  it('BK-030 关掉一本再开另一本，翻页只作用于当前这本', async () => {
    const fake = shelf()
    seed(fake, [
      record(),
      record({ id: 'b2', title: '河上的船', file: 'files/b2.epub' })
    ], { 'files/b1.epub': BOOK_BODY, 'files/b2.epub': '第一章 船\n正文' })
    const m = await mount(fake)

    await m.press('起风了')
    await m.settle()
    const first = foliate.views[0]!
    await m.key('ArrowRight')
    expect(first.nextCalls).toBe(1)

    await m.pressIn('.icon-btn')  // 回书架那颗是纯图标键
    await m.press('河上的船')
    await m.settle()
    const second = foliate.views[1]!
    await m.key('ArrowRight')
    await m.key('ArrowRight')
    expect(second.nextCalls).toBe(2)
    // 已经关掉的那本不再吃键
    expect(first.nextCalls).toBe(1)
    m.unmount()
  })
})
