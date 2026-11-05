import { describe, expect, it } from 'vitest'
import {
  addBook,
  bookPath,
  coverUrl,
  loadBooks,
  removeBook,
  saveBooks,
  setProgress,
  type BookRecord
} from '@shared/library'
import { FakeAirship } from '@tests/helpers/fakeAirship'

/**
 * LB 册子（docs/specs/library.md）。
 *
 * 拿 FakeAirship 当壳：书库落在共享命名空间 `library` 里，
 * 所有断言读的都是那份内存卷与索引文件的原文，不看内部实现。
 */

const SHARED = '/fake/userData/shared/library'
const INDEX = `${SHARED}/library.json`

function shelf(id: string): FakeAirship {
  return new FakeAirship({
    id,
    capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'shared', 'log'],
    sharedNamespaces: ['library']
  })
}

/** 源文件放在共享区之外：先用对话框"选中"它，才有读的权利 */
function grant(fake: FakeAirship, path: string): void {
  fake.readGrants.add(path)
}

/** 另一个应用读同一个目录：卷与授权各一份，数据是同一份 */
function twin(from: FakeAirship, id: string): FakeAirship {
  const other = shelf(id)
  for (const [p, c] of from.vol) other.vol.set(p, c)
  for (const d of from.dirSet) other.dirSet.add(d)
  return other
}

function indexed(fake: FakeAirship): { version: number; books: BookRecord[] } {
  return JSON.parse(fake.text(INDEX)) as { version: number; books: BookRecord[] }
}

describe('索引文件自己带版本', () => {
  it('LB-001 书库还空着时读到的是空表', async () => {
    const fake = shelf('books')
    expect(await loadBooks(fake.api)).toEqual([])
  })

  it('LB-002 v2 的索引按原样读出，落盘也带 version: 2', async () => {
    const fake = shelf('books')
    const src = '/fake/media/起风了.epub'
    fake.seed(src, 'EPUB'.repeat(8))
    grant(fake, src)
    const book = await addBook(fake.api, { sourcePath: src, format: 'epub', title: '起风了', author: '堀辰雄' })

    const [again] = await loadBooks(fake.api)
    expect(again).toBeTruthy()
    expect(again!.id).toBe(book.id)
    expect(again!.title).toBe('起风了')
    expect(again!.author).toBe('堀辰雄')
    expect(again!.format).toBe('epub')
    expect(again!.file).toBe(book.file)
    expect(again!.cover).toBeNull()
    expect(again!.size).toBe(32)
    expect(again!.progress).toBeNull()
    expect(again!.meta).toEqual({})
    expect(indexed(fake).version).toBe(2)
  })

  it('LB-003 版本对不上时报出该删哪个文件', async () => {
    const fake = shelf('books')
    fake.seed(INDEX, '{"version":1,"books":[]}')
    await expect(loadBooks(fake.api)).rejects.toThrow('书库索引是 v1，本包只认 v2。')
    const message = await loadBooks(fake.api).catch((e: unknown) => String(e))
    expect(message).toContain('删掉 userData/shared/library/library.json')
    expect(message).toContain('书本体和封面不用动')

    // 没写版本的同样被拒，念出来的是 v?
    const blank = shelf('books')
    blank.seed(INDEX, '{"books":[]}')
    await expect(loadBooks(blank.api)).rejects.toThrow('书库索引是 v?，本包只认 v2。')
  })

  it('LB-004 索引里 books 不是列表时单独报错', async () => {
    const fake = shelf('books')
    fake.seed(INDEX, '{"version":2,"books":{"a":1}}')
    await expect(loadBooks(fake.api)).rejects.toThrow('书库索引格式不正确')
  })
})

describe('判重在拷贝之前', () => {
  it('LB-005 大小与标题都对上就算同一本，不多拷一份', async () => {
    const fake = shelf('books')
    const first = '/fake/media/书名.epub'
    fake.seed(first, 'A'.repeat(64))
    grant(fake, first)
    const before = await addBook(fake.api, { sourcePath: first, format: 'epub', title: '同一本', author: '' })
    const filesBefore = [...fake.vol.keys()].filter((p) => p.startsWith(`${SHARED}/files/`)).length

    // 换个路径再导一次：大小与标题都一样 → 就是同一本
    const again = '/fake/other/同名副本.epub'
    fake.seed(again, 'A'.repeat(64))
    grant(fake, again)
    const after = await addBook(fake.api, { sourcePath: again, format: 'epub', title: '同一本', author: '' })

    expect(after.id).toBe(before.id)
    expect(await loadBooks(fake.api)).toHaveLength(1)
    const filesAfter = [...fake.vol.keys()].filter((p) => p.startsWith(`${SHARED}/files/`)).length
    expect(filesAfter).toBe(filesBefore)
  })

  it('LB-006 只有大小对上不是同一本', async () => {
    const fake = shelf('books')
    const a = '/fake/media/a.epub'
    const b = '/fake/media/b.epub'
    fake.seed(a, 'B'.repeat(50))
    fake.seed(b, 'B'.repeat(50))
    grant(fake, a)
    grant(fake, b)
    const one = await addBook(fake.api, { sourcePath: a, format: 'epub', title: '甲', author: '' })
    const two = await addBook(fake.api, { sourcePath: b, format: 'epub', title: '乙', author: '' })

    expect(two.id).not.toBe(one.id)
    expect((await loadBooks(fake.api)).length).toBe(2)
    expect(fake.vol.has(`${SHARED}/files/${two.id}.epub`)).toBe(true)
  })

  it('LB-007 新书排在最前，本体落在 files/<书号>.<扩展名>', async () => {
    const fake = shelf('books')
    const src = '/fake/media/河上的船.MOBI'
    fake.seed(src, 'mobi-bytes')
    grant(fake, src)
    const book = await addBook(fake.api, { sourcePath: src, format: 'mobi', title: '河上的船', author: '' })

    expect(book.file).toBe(`files/${book.id}.mobi`)
    const dest = await bookPath(fake.api, book)
    expect(dest).toBe(`${SHARED}/files/${book.id}.mobi`)
    expect(fake.text(dest)).toBe('mobi-bytes')

    // 源文件删掉后，读的还是书库里那一份副本
    fake.vol.delete(src)
    const [listed] = await loadBooks(fake.api)
    expect(listed!.title).toBe('河上的船')
    expect(fake.text(await bookPath(fake.api, listed!))).toBe('mobi-bytes')
  })
})

describe('封面由导入方交进来', () => {
  it('LB-008 给了封面字节就存，没给也照样导入', async () => {
    const fake = shelf('books')
    const withCover = '/fake/media/有封面.epub'
    const noCover = '/fake/media/没封面.epub'
    fake.seed(withCover, 'x'.repeat(20))
    fake.seed(noCover, 'y'.repeat(20))
    grant(fake, withCover)
    grant(fake, noCover)

    const a = await addBook(fake.api, {
      sourcePath: withCover,
      format: 'epub',
      title: '有封面',
      author: '',
      coverBytes: new TextEncoder().encode('PNGDATA'),
      coverExt: 'png'
    })
    const b = await addBook(fake.api, { sourcePath: noCover, format: 'epub', title: '没封面', author: '' })

    expect(a.cover).toBe(`covers/${a.id}.png`)
    expect(fake.text(`${SHARED}/covers/${a.id}.png`)).toBe('PNGDATA')
    expect(b.cover).toBeNull()
    expect((await loadBooks(fake.api)).length).toBe(2)
  })

  it('LB-009 封面位置能直接交给图片用，没封面的得到空值', async () => {
    const fake = shelf('books')
    const src = '/fake/media/c.epub'
    fake.seed(src, 'z'.repeat(9))
    grant(fake, src)
    const withCover = await addBook(fake.api, {
      sourcePath: src,
      format: 'epub',
      title: 'c',
      author: '',
      coverBytes: new TextEncoder().encode('IMG')
    })
    const url = await coverUrl(fake.api, withCover)
    expect(url).toBe('file:///fake/userData/shared/library/covers/' + withCover.id + '.jpg')
    expect(url!.startsWith('file:///')).toBe(true)

    const bare: BookRecord = { ...withCover, cover: null }
    expect(await coverUrl(fake.api, bare)).toBeNull()
  })
})

describe('删除连索引带文件一起清', () => {
  it('LB-010 删一本书把本体与封面一起删掉，别的书不动', async () => {
    const fake = shelf('books')
    const src = '/fake/media/del.epub'
    const keep = '/fake/media/keep.epub'
    fake.seed(src, 'd'.repeat(12))
    fake.seed(keep, 'k'.repeat(13))
    grant(fake, src)
    grant(fake, keep)
    const doomed = await addBook(fake.api, {
      sourcePath: src,
      format: 'epub',
      title: '要删的',
      author: '',
      coverBytes: new TextEncoder().encode('C')
    })
    const kept = await addBook(fake.api, { sourcePath: keep, format: 'epub', title: '留下的', author: '' })

    await removeBook(fake.api, doomed.id)

    const left = await loadBooks(fake.api)
    expect(left.map((b) => b.id)).toEqual([kept.id])
    expect(fake.vol.has(`${SHARED}/files/${doomed.id}.epub`)).toBe(false)
    expect(fake.vol.has(`${SHARED}/covers/${doomed.id}.jpg`)).toBe(false)
    expect(fake.vol.has(`${SHARED}/files/${kept.id}.epub`)).toBe(true)
  })

  it('LB-011 删一个没登记过的书号什么都不动', async () => {
    const fake = shelf('books')
    const src = '/fake/media/e.epub'
    fake.seed(src, 'e'.repeat(7))
    grant(fake, src)
    const book = await addBook(fake.api, { sourcePath: src, format: 'epub', title: 'e', author: '' })
    const before = [...fake.vol.keys()]

    await removeBook(fake.api, '没有这个书号')

    expect((await loadBooks(fake.api)).map((b) => b.id)).toEqual([book.id])
    expect([...fake.vol.keys()].sort()).toEqual(before.sort())
  })
})

describe('进度与附加信息是两个应用共用的一份', () => {
  it('LB-012 进度四个字段存得下也读得出，也能抹掉', async () => {
    const fake = shelf('books')
    const src = '/fake/media/p.epub'
    fake.seed(src, 'p'.repeat(11))
    grant(fake, src)
    const book = await addBook(fake.api, { sourcePath: src, format: 'epub', title: 'p', author: '' })

    await setProgress(fake.api, book.id, {
      section: 3,
      fraction: 0.25,
      cfi: 'epubcfi(/6/12!/4:1)',
      updatedAt: '2026-11-03T08:00:00.000Z'
    })
    const [read] = await loadBooks(fake.api)
    expect(read!.progress).toEqual({
      section: 3,
      fraction: 0.25,
      cfi: 'epubcfi(/6/12!/4:1)',
      updatedAt: '2026-11-03T08:00:00.000Z'
    })

    await setProgress(fake.api, book.id, null)
    const [cleared] = await loadBooks(fake.api)
    expect(cleared!.progress).toBeNull()
  })

  it('LB-013 墨读写的进度，PDF 从同一份索引读到', async () => {
    const books = shelf('books')
    const epub = '/fake/media/共读.epub'
    const pdf = '/fake/media/规格书.pdf'
    books.seed(epub, 'u'.repeat(15))
    books.seed(pdf, 'd'.repeat(16))
    grant(books, epub)
    grant(books, pdf)
    const mine = await addBook(books.api, { sourcePath: epub, format: 'epub', title: '共读', author: '' })
    await addBook(books.api, { sourcePath: pdf, format: 'pdf', title: '规格书', author: '' })
    await setProgress(books.api, mine.id, { section: 2, fraction: 0.5, cfi: 'x', updatedAt: '2026-11-04T00:00:00.000Z' })

    const pdfApp = twin(books, 'pdf')
    const all = await loadBooks(pdfApp.api)
    expect(all.find((b) => b.id === mine.id)?.progress?.section).toBe(2)
    // 两个应用按格式各筛各的，看到的仍是同一批记录
    expect(all.filter((b) => b.format === 'pdf').map((b) => b.title)).toEqual(['规格书'])
    expect(all.filter((b) => b.format !== 'pdf').map((b) => b.title)).toEqual(['共读'])
  })

  it('LB-014 附加信息各存各的键，更新一本不动另一本', async () => {
    const fake = shelf('pdf')
    const doc = '/fake/media/带页数.pdf'
    const other = '/fake/media/带章名.epub'
    fake.seed(doc, 'q'.repeat(18))
    fake.seed(other, 'r'.repeat(19))
    grant(fake, doc)
    grant(fake, other)
    await addBook(fake.api, { sourcePath: doc, format: 'pdf', title: '带页数', author: '', meta: { pages: 7 } })
    const e = await addBook(fake.api, {
      sourcePath: other,
      format: 'epub',
      title: '带章名',
      author: '',
      meta: { lastChapter: '起风了' }
    })

    const before = await loadBooks(fake.api)
    expect(before.find((b) => b.format === 'pdf')?.meta).toEqual({ pages: 7 })
    expect(before.find((b) => b.format === 'epub')?.meta).toEqual({ lastChapter: '起风了' })
    // 索引里没有为某个格式专设的顶层字段
    expect(Object.keys(indexed(fake).books[0]!).sort()).toEqual(
      ['addedAt', 'author', 'cover', 'file', 'format', 'id', 'meta', 'progress', 'size', 'title']
    )

    await setProgress(fake.api, e.id, { section: 1, fraction: 0, cfi: null, updatedAt: '2026-11-05T00:00:00.000Z' })
    const after = await loadBooks(fake.api)
    expect(after.find((b) => b.format === 'pdf')?.meta).toEqual({ pages: 7 })
  })

  it('LB-015 连续导入两本，后一次不吞掉前一次', async () => {
    const fake = shelf('books')
    const a = '/fake/media/f1.epub'
    const b = '/fake/media/f2.epub'
    fake.seed(a, '1'.repeat(21))
    fake.seed(b, '2'.repeat(22))
    grant(fake, a)
    grant(fake, b)

    // 界面就是一条一条 await 的：前一本登记完才轮到下一本
    await addBook(fake.api, { sourcePath: a, format: 'epub', title: '一本', author: '' })
    await addBook(fake.api, { sourcePath: b, format: 'epub', title: '另一本', author: '' })

    const titles = (await loadBooks(fake.api)).map((x) => x.title)
    expect(titles.sort()).toEqual(['一本', '另一本'].sort())

    // 落盘排队：紧跟着的两次写都不留半截文件
    const list = await loadBooks(fake.api)
    await Promise.all([saveBooks(fake.api, list), saveBooks(fake.api, list)])
    expect(() => JSON.parse(fake.text(INDEX))).not.toThrow()
    expect((await loadBooks(fake.api)).length).toBe(2)
  })
})
