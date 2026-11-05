import { describe, expect, it } from 'vitest'
import { txtToHtml } from '../txtBook'

/**
 * TXT 排版层——只管切章与分段，编码识别在 @shared/textdecode。
 *
 * 章节识别是这里最容易退化的一块：RN 原版的正则要求标题行只有"第一章"这种光杆标记，
 * 带章名的常见写法会被当成正文，整本书切不出章。这几条测试就是钉住这个行为。
 * 标题里的编号对应 docs/specs/books.md。
 */

describe('章节识别', () => {
  it('BK-011 章号后带章名也要认（中文网文的常见写法）', () => {
    const html = txtToHtml('第一章 起风了\n风从河面上过来。\n\n第二章 河上的船\n船是半夜来的。')
    expect(html).toContain('<h1>第一章 起风了</h1>')
    expect(html).toContain('<h1>第二章 河上的船</h1>')
    expect(html.match(/<p>/g)?.length).toBe(2)
  })

  it('BK-012 光杆标记、序言、后记都认', () => {
    const html = txtToHtml('第一章\n正文一\n\n序言\n正文二\n\n后记\n正文三')
    expect(html).toContain('<h1>第一章</h1>')
    expect(html).toContain('<h1>序言</h1>')
    expect(html).toContain('<h1>后记</h1>')
  })

  it('BK-013 长行不当标题，避免把正文切成章', () => {
    const long = `第一章 ${'这是一段很长很长的正文，本来就不是标题，'.repeat(3)}`
    const html = txtToHtml(long)
    expect(html).not.toContain('<h1>')
  })

  it('BK-014 空行分段，段落内换行合并', () => {
    const html = txtToHtml('第一行\n第二行\n\n第三段')
    expect(html.match(/<p>/g)?.length).toBe(2)
    expect(html).toContain('第一行第二行')
  })

  it('BK-015 转义 HTML 特殊字符', () => {
    const html = txtToHtml('他说"<别这样>" & 然后 { }')
    expect(html).toContain('&lt;')
    expect(html).toContain('&gt;')
    expect(html).toContain('&amp;')
  })
})
