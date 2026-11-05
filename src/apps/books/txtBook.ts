/**
 * TXT / HTML 书适配器，继承 RN 版 reader.js 的做法：
 * 整本读入（这类文件本身小），按标题切节，喂给 foliate 的分页器。
 *
 * 编码识别不在这里——那是 @shared/textdecode 的事，墨读和 vcp 共用。
 */

/**
 * 章节标题识别。
 *
 * 与 RN 原版的差别（有意为之）：原版要求标题行只有"第一章"这种光杆标记，
 * 于是"第一章 起风了"这类最常见的写法会被当成正文，整本书切不出章。
 * 这里允许标记后跟章名，但限制长度，避免把正文误认成标题。
 */
const HEADING =
  /^\s*(第\s*[0-9零〇一二三四五六七八九十百千万亿两]+\s*[章回节卷篇].{0,30}|序[言章]?.{0,20}|后记|尾声|附录|楔子|前言|[A-Z][0-9]{1,3}\s+.*|Chapter\s+\d+.*)\s*$/

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!
  )
}

export function txtToHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []

  const flush = (): void => {
    if (!paragraph.length) return
    out.push(`<p>${escapeHtml(paragraph.join('')).replace(/\s+/g, ' ')}</p>`)
    paragraph = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (line.length <= 40 && HEADING.test(line)) {
      flush()
      out.push(`<h1>${escapeHtml(line)}</h1>`)
      continue
    }
    paragraph.push(line)
    // 长段落兜底：没有空行分隔的文本也不能无限堆下去
    if (paragraph.join('').length > 600) flush()
  }
  flush()
  return out.join('\n')
}

export interface BookTheme {
  ink: string
  paper: string
}

function wrapDoc(innerHtml: string, theme: BookTheme): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
   html,body{margin:0;padding:0;background:${theme.paper};color:${theme.ink};
   font-family:serif;line-height:1.6;} p{margin:0 0 .6em;text-indent:2em;} h1,h2{margin:.4em 0 .8em;}
   </style></head><body>${innerHtml}</body></html>`
}

interface TxtSection {
  id: string
  linear: string
  size: number
  cfi: string
  load(): string
  unload(): void
  createDocument(): Promise<Document>
}

/** 把整本 HTML 切成节，返回 foliate 能直接 open 的 book 对象 */
export function makeTextBook(options: { title: string; bodyHtml: string; theme: BookTheme }): unknown {
  const { title, theme } = options
  const parts = String(options.bodyHtml)
    .split(/(?=<h[12][\s>])/i)
    .filter((part) => part.trim())
  const chunks = parts.length ? parts : [String(options.bodyHtml)]

  const headingOf = (chunk: string): string => {
    const doc = new DOMParser().parseFromString(chunk, 'text/html')
    return (doc.querySelector('h1, h2')?.textContent ?? '').trim()
  }

  const sections: TxtSection[] = chunks.map((chunk, index) => {
    let url: string | null = null
    return {
      id: String(index),
      linear: 'yes',
      size: chunk.length,
      cfi: `html/${index}`,
      load() {
        if (!url) {
          url = URL.createObjectURL(new Blob([wrapDoc(chunk, theme)], { type: 'text/html' }))
        }
        return url
      },
      unload() {
        if (url) URL.revokeObjectURL(url)
        url = null
      },
      async createDocument() {
        return new DOMParser().parseFromString(wrapDoc(chunk, theme), 'text/html')
      }
    }
  })

  return {
    key: 'html',
    metadata: { title },
    dir: 'ltr',
    toc: sections.map((section, index) => ({
      label: headingOf(chunks[index]!) || `第 ${index + 1} 节`,
      href: String(index)
    })),
    sections,
    progression: {
      spine: { items: sections.map((section, index) => ({ href: String(index), role: null })), linear: 'yes' },
      page: { pages: [], linear: 'yes' }
    },
    resolveHref(href: string) {
      const index = Number(href)
      return { index: Number.isFinite(index) ? index : 0, anchor: () => null }
    },
    resolveCFI(cfi: string) {
      const index = Number(String(cfi).split('/').pop())
      return { index: Number.isFinite(index) ? index : 0, anchor: () => null }
    },
    isExternal: () => false
  }
}
