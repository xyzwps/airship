// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeBook } from 'foliate-js/view.js'

/**
 * BK-032：MOBI 这条通路拿真文件验。
 *
 * 样本是 `python code/make-mobi.py` 造的《道德經》（全本八十一章，MOBI6、不压缩、UTF-8）。
 * 验的是我们这条链：按扩展名归到 mobi → remoteFile 那个"按范围取字节"的 File-like →
 * 元数据、节数与逐节正文都落得下来。再往下的解压器分支属于 foliate-js，不在这本册子上。
 * 排版观感归 `just shot`（AIRSHIP_AUTOTEST 指这份文件就能看到阅读器真打开它）。
 */

const FIXTURE = join(__dirname, 'fixtures', '道德经.mobi')
const bytes = () => new Uint8Array(readFileSync(FIXTURE))

/** foliate 要的 File-like：只用 slice(...).arrayBuffer()，按范围取字节 */
function fileFrom(buf: Uint8Array, name: string) {
  return {
    name,
    size: buf.byteLength,
    type: 'application/octet-stream',
    arrayBuffer: async () => new Uint8Array(buf).slice().buffer,
    slice: (from?: number, to?: number) => {
      const part = new Uint8Array(buf).subarray(from ?? 0, to ?? buf.byteLength)
      return { arrayBuffer: async () => part.slice().buffer }
    }
  }
}

type OpenedBook = {
  metadata?: { title?: unknown; author?: unknown }
  sections: Array<{ id: number; size: number; createDocument(): Promise<Document> }>
}

describe('MOBI 读得开（BK-032）', () => {
  it('BK-032 交一个 MOBI 出去，读得出书名、作者与分节', async () => {
    // 只问我们这一侧的事：把这个文件交出去，壳拿到的是一本有名字、有节、能翻页的书。
    // 解压器那三条分支（不压 / PalmDOC LZ77 / huff）在 foliate-js 里，是它的实现细节，不在这里的契约上。
    const file = fileFrom(bytes(), '道德经.mobi')
    const book = (await makeBook(file as never)) as OpenedBook
    expect(String(book.metadata?.title)).toContain('道德經')
    expect(String(JSON.stringify(book.metadata?.author))).toContain('老子')
    // 扉页 + 道经/德经两册 + 八十一章
    expect(book.sections.length).toBe(84)
    // 每一节都得有内容：第一版把 pagebreak 放在最前面，切出一张空页，真打开就是白屏
    for (const section of book.sections) expect(section.size, `第 ${section.id} 节`).toBeGreaterThan(0)
  }, 30_000)

  it('BK-032 正文按章切开，翻到第一章读到的是第一章的字', async () => {
    const book = (await makeBook(fileFrom(bytes(), '道德经.mobi') as never)) as OpenedBook
    // 节 0 是扉页，节 1 是「道經」那一册的封面页，节 2 起才是章
    const ch1 = await book.sections[2].createDocument()
    expect(ch1.body.textContent).toContain('第一章')
    expect(ch1.body.textContent).toContain('道，可道也')
    const ch2 = await book.sections[3].createDocument()
    expect(ch2.body.textContent).toContain('天下皆知美之為美')
  }, 30_000)
})
