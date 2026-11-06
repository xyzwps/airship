import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { makeBook } from 'foliate-js/view.js'
import { useTheme } from '../../shell/theme'
import { IconButton } from '../../shell/IconButton'
import { useAppAutotest } from '../../shell/autotest'
import { markPerf } from '../../shell/shot'
import type { AppApi } from '@shared/protocol'
import {
  addBook,
  coverUrl,
  loadBooks,
  removeBook,
  setProgress,
  type BookProgress,
  type BookRecord
} from '@shared/library'
import { remoteFile } from './remoteFile'
import { ReaderView, type ReaderHandle, type TocItem } from './ReaderView'
import './books.css'

/**
 * 墨读 —— EPUB / MOBI / TXT。
 *
 * 书架与阅读器两个视图。书库在壳级共享区，pdf 应用看到的是同一份索引，
 * 这里只按格式筛出非 PDF 的。
 *
 * 导入时元数据和封面用 foliate 的 makeBook 读（EPUB 与 MOBI 都支持 getCover），
 * 读不出来就退化成"文件名当标题、无封面"，不让导入失败。
 */

const FONT_MIN = 0.8
const FONT_MAX = 1.4

function paperTheme(resolved: 'light' | 'dark'): { ink: string; paper: string } {
  return resolved === 'dark' ? { ink: '#d8d3c8', paper: '#23201b' } : { ink: '#1c1a17', paper: '#f7f2e9' }
}

function labelOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return labelOf(value[0])
  if (value && typeof value === 'object') {
    for (const candidate of Object.values(value as Record<string, unknown>)) {
      if (typeof candidate === 'string') return candidate
    }
  }
  return ''
}

interface ImportedMeta {
  title: string
  author: string
  coverBytes?: Uint8Array
  coverExt?: string
}

async function readMeta(api: AppApi, path: string, size: number, fallbackTitle: string): Promise<ImportedMeta> {
  try {
    const file = remoteFile(api, path, size, fallbackTitle)
    const book = (await makeBook(file as never)) as {
      metadata?: { title?: unknown; author?: unknown }
      getCover?(): Promise<Blob | null>
    }
    const meta: ImportedMeta = {
      title: labelOf(book.metadata?.title) || fallbackTitle,
      author: labelOf(book.metadata?.author)
    }
    try {
      const cover = await book.getCover?.()
      if (cover && cover.size > 0) {
        meta.coverBytes = new Uint8Array(await cover.arrayBuffer())
        meta.coverExt = cover.type.includes('png') ? 'png' : cover.type.includes('webp') ? 'webp' : 'jpg'
      }
    } catch {
      /* 没封面就算了 */
    }
    return meta
  } catch {
    return { title: fallbackTitle, author: '' }
  }
}

export default function BooksApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const theme = useMemo(() => paperTheme(resolved), [resolved])

  const [books, setBooks] = useState<BookRecord[]>([])
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  const [hydrated, setHydrated] = useState(false)
  const [openBook, setOpenBook] = useState<BookRecord | null>(null)
  const [fontScale, setFontScale] = useState(1)
  const [toc, setToc] = useState<TocItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sectionCount, setSectionCount] = useState(0)
  const [pos, setPos] = useState({ section: 0, fraction: 0 })

  const readerRef = useRef<ReaderHandle>(null)
  const progressRef = useRef<BookProgress | null>(null)
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  /* ---------- 书架载入 ---------- */

  const refresh = useCallback(async () => {
    const all = await loadBooks(api)
    const mine = all.filter((b) => b.format !== 'pdf')
    setBooks(mine)
    const map: Record<string, string | null> = {}
    for (const b of mine) map[b.id] = await coverUrl(api, b)
    setCovers(map)
  }, [api])

  useEffect(() => {
    let alive = true
    void api.settings.get<{ fontScale?: number }>('prefs', { fontScale: 1 }).then((p) => {
      if (alive && typeof p.fontScale === 'number') setFontScale(p.fontScale)
    })
    refresh()
      .then(() => alive && setHydrated(true))
      .catch((err: unknown) => {
        if (!alive) return
        setHydrated(true)
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [api, refresh])

  /* ---------- 进度：节流落盘 ---------- */

  const handleProgress = useCallback(
    (p: BookProgress) => {
      progressRef.current = p
      setPos({ section: p.section ?? 0, fraction: p.fraction ?? 0 })
      if (flushTimer.current) return
      flushTimer.current = setTimeout(() => {
        flushTimer.current = null
        const latest = progressRef.current
        if (!latest || !openBook) return
        void setProgress(api, openBook.id, latest)
        setBooks((prev) => prev.map((b) => (b.id === openBook.id ? { ...b, progress: latest } : b)))
      }, 1500)
    },
    [api, openBook]
  )

  useEffect(() => {
    return () => {
      if (flushTimer.current) clearTimeout(flushTimer.current)
      const latest = progressRef.current
      if (latest && openBook) void setProgress(api, openBook.id, latest)
    }
  }, [api, openBook])

  /* ---------- 导入 / 删除 ---------- */

  const importPath = useCallback(
    async (path: string) => {
      const stat = await api.fs.stat(path)
      if (!stat) throw new Error(`读不到文件：${path}`)
      const name = path.split(/[\\/]/).pop() ?? path
      const fallback = name.replace(/\.[a-z0-9]{1,5}$/i, '')
      const ext = (name.split('.').pop() ?? '').toLowerCase()
      const format = ext === 'mobi' || ext === 'azw3' ? 'mobi' : ext === 'txt' ? 'txt' : 'epub'

      let meta: ImportedMeta = { title: fallback, author: '' }
      if (format !== 'txt') meta = await readMeta(api, path, stat.size, fallback)

      return addBook(api, {
        sourcePath: path,
        format,
        title: meta.title,
        author: meta.author,
        coverBytes: meta.coverBytes,
        coverExt: meta.coverExt
      })
    },
    [api]
  )

  const runImport = async () => {
    if (importing) return
    setImporting(true)
    setError(null)
    try {
      const picked = await api.dialog.openFiles({
        title: '选择要导入的书',
        filters: [
          { name: '电子书', extensions: ['epub', 'mobi', 'azw3', 'txt'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (!picked) return
      for (const path of picked) await importPath(path)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  /* ---------- 截图模式自动化：真书验证 ---------- */

  useAppAutotest(
    'books',
    async (path) => {
      const record = await importPath(path)
      await refresh()
      setOpenBook(record)
    },
    setError
  )

  const runRemove = async (book: BookRecord) => {
    if (!window.confirm(`从书架移除《${book.title}》？本地副本和封面会一起删掉。`)) return
    await removeBook(api, book.id)
    await refresh()
  }

  /* ---------- 阅读器工具 ---------- */

  const changeFont = (delta: number) => {
    setFontScale((prev) => {
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round((prev + delta) * 10) / 10))
      void api.settings.set('prefs', { fontScale: next })
      return next
    })
  }

  const jumpToc = (href: string) => {
    readerRef.current?.goTo(href)
    setTocOpen(false)
  }

  // 书名是"正在看什么"，交给标题栏中段；合上就收回，任务栏恢复成只念应用名
  useEffect(() => {
    void api.window.setTitle(openBook ? (openBook.author ? `${openBook.title} · ${openBook.author}` : openBook.title) : null)
  }, [api, openBook])

  /* ---------- 渲染 ---------- */

  if (openBook) {
    return (
      <div className="books-reader" style={{ background: theme.paper, color: theme.ink }}>
        <header className="books-reader__bar">
          <IconButton
            icon="back"
            label="返回书架"
            testId="回书架"
            onClick={() => setOpenBook(null)}
          />

          <div className="row">
            <button type="button" className="btn btn--ghost" onClick={() => setTocOpen((v) => !v)} disabled={toc.length === 0}>
              目录{toc.length ? ` ${toc.length}` : ''}
            </button>
            <button type="button" className="btn btn--ghost" onClick={() => changeFont(-0.1)} disabled={fontScale <= FONT_MIN}>
              A−
            </button>
            <span className="books-reader__scale">{Math.round(fontScale * 100)}%</span>
            <button type="button" className="btn btn--ghost" onClick={() => changeFont(0.1)} disabled={fontScale >= FONT_MAX}>
              A＋
            </button>

          </div>
        </header>

        <div className="books-reader__body">
          {tocOpen && (
            <aside className="books-reader__toc">
              {toc.map((item, i) => (
                <button
                  key={`${item.href}-${i}`}
                  type="button"
                  className="books-reader__toc-item"
                  style={{ paddingLeft: 10 + item.depth * 14 }}
                  onClick={() => jumpToc(item.href)}
                >
                  {item.label || `第 ${i + 1} 项`}
                </button>
              ))}
            </aside>
          )}
          <ReaderView
            ref={readerRef}
            api={api}
            book={openBook}
            theme={theme}
            fontScale={fontScale}
            onProgress={handleProgress}
            onToc={setToc}
            onReady={(count) => {
              markPerf('阅读器首屏渲染完')
              setSectionCount(count)
            }}
            onError={(m) => setError(m)}
          />
        </div>

        {error && <div className="books-reader__error">{error}</div>}
        <div className="books-reader__hint">
          {'方向键 / 空格 / 滚轮翻页 · '}
          第 {Math.min(pos.section + 1, sectionCount || 1)} / {sectionCount} 节 · 约{' '}
          {sectionCount === 0 ? 0 : Math.min(100, Math.round(((pos.section + pos.fraction) / sectionCount) * 100))}%
        </div>
      </div>
    )
  }

  return (
    <div className="books-shelf">
      <header className="books-shelf__head">
        <div>
          <h1 className="books-shelf__title">墨读</h1>
          <p className="hint">EPUB / MOBI / TXT，与 PDF 应用共用同一个书架</p>
        </div>
        <button type="button" className="btn btn--primary" disabled={importing} onClick={() => void runImport()}>
          {importing ? '导入中…' : '导入书籍'}
        </button>
      </header>

      {error && <div className="books-shelf__error">{error}</div>}

      {!hydrated ? (
        <div className="placeholder">
          <div className="spinner" />
        </div>
      ) : books.length === 0 ? (
        <div className="books-shelf__empty">书架是空的。点右上角导入一本试试。</div>
      ) : (
        <div className="books-shelf__grid">
          {books.map((book) => (
            <div key={book.id} className="book-card">
              <button type="button" className="book-card__cover" onClick={() => setOpenBook(book)}>
                {covers[book.id] ? (
                  <img src={covers[book.id]!} alt="" />
                ) : (
                  <span className="book-card__no-cover">{book.title.slice(0, 4)}</span>
                )}
                {book.progress && (
                  <span className="book-card__progress">
                    <span
                      className="book-card__progress-fill"
                      style={{
                        width: `${Math.round(
                          ((book.progress.section + book.progress.fraction) /
                            Math.max(1, book.progress.section + 1)) *
                            100
                        )}%`
                      }}
                    />
                  </span>
                )}
              </button>
              <div className="book-card__meta">
                <button type="button" className="book-card__title" title={book.title} onClick={() => setOpenBook(book)}>
                  {book.title}
                </button>
                <span className="book-card__sub">
                  {book.author || book.format.toUpperCase()}
                </span>
              </div>
              <button type="button" className="btn btn--ghost book-card__del" onClick={() => void runRemove(book)}>
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
