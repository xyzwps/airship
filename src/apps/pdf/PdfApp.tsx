import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { useTheme } from '../../shell/theme'
import type { AppApi } from '@shared/protocol'
import {
  addBook,
  bookPath,
  coverUrl,
  loadBooks,
  removeBook,
  setProgress,
  type BookRecord
} from '@shared/library'
import { useAppAutotest } from '../../shell/autotest'
import { markPerf } from '../../shell/shot'
import './pdf.css'

/**
 * PDF 阅读器。
 *
 * 和 RN 版的根本差别：RN 版靠系统渲染器逐页出位图（Windows.Data.Pdf /
 * Android PdfRenderer），Electron 里有 Chromium，直接交给 pdf.js 做矢量渲染，
 * 文字可选中、缩放不糊，也不再需要"打开一次、翻页传句柄"那套原生句柄管理。
 *
 * 书库与墨读共用：这里只筛 format === 'pdf'。
 *
 * 已知取舍：getDocument 吃整份字节，超大扫描版 PDF 会占内存。
 * 真碰到再上 range request（pdf.js 支持），现在不为没出现的问题加复杂度。
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc

const ZOOM_MIN = 0.5
const ZOOM_MAX = 4

export default function PdfApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()

  const [books, setBooks] = useState<BookRecord[]>([])
  const [covers, setCovers] = useState<Record<string, string | null>>({})
  const [hydrated, setHydrated] = useState(false)
  const [openBook, setOpenBook] = useState<BookRecord | null>(null)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const all = await loadBooks(api)
    const mine = all.filter((b) => b.format === 'pdf')
    setBooks(mine)
    const map: Record<string, string | null> = {}
    for (const b of mine) map[b.id] = await coverUrl(api, b)
    setCovers(map)
  }, [api])

  useEffect(() => {
    let alive = true
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

  /* ---------- 导入 ---------- */

  const importFrom = useCallback(
    async (path: string) => {
      const stat = await api.fs.stat(path)
      if (!stat) throw new Error(`读不到文件：${path}`)

      const bytes = await api.fs.read(path)
      const loadingTask = pdfjs.getDocument({ data: bytes.slice() })
      const doc = await loadingTask.promise
      const pages = doc.numPages

      // 封面：第一页渲成小图
      let coverBytes: Uint8Array | undefined
      try {
        const page = await doc.getPage(1)
        const viewport = page.getViewport({ scale: 1 })
        const scale = 180 / viewport.width
        const small = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(small.width)
        canvas.height = Math.ceil(small.height)
        await page.render({ canvas, viewport: small }).promise
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82))
        if (blob) coverBytes = new Uint8Array(await blob.arrayBuffer())
      } catch {
        /* 封面失败不影响导入 */
      }
      await loadingTask.destroy()

      const name = path.split(/[\\/]/).pop() ?? path
      await addBook(api, {
        sourcePath: path,
        format: 'pdf',
        title: name.replace(/\.pdf$/i, ''),
        author: '',
        meta: { pages },
        coverBytes,
        coverExt: 'jpg'
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
        title: '选择要导入的 PDF',
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (!picked) return
      for (const path of picked) await importFrom(path)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setImporting(false)
    }
  }

  const runRemove = async (book: BookRecord) => {
    if (!window.confirm(`从书架移除《${book.title}》？本地副本和封面会一起删掉。`)) return
    await removeBook(api, book.id)
    await refresh()
  }

  /* ---------- 截图模式自动化：真文件验证 ---------- */

  useAppAutotest(
    'pdf',
    async (path) => {
      await importFrom(path)
      await refresh()
      const all = await loadBooks(api)
      const target = all.find((b) => b.format === 'pdf')
      if (target) setOpenBook(target)
    },
    setError
  )

  /* ---------- 渲染 ---------- */

  if (openBook) {
    return (
      <PdfReader
        api={api}
        book={openBook}
        dark={resolved === 'dark'}
        onBack={() => {
          setOpenBook(null)
          void refresh()
        }}
        onError={setError}
      />
    )
  }

  return (
    <div className="pdf-shelf">
      <header className="pdf-shelf__head">
        <div>
          <h1 className="pdf-shelf__title">PDF</h1>
          <p className="hint">与墨读共用同一个书架，这里只列 PDF</p>
        </div>
        <button type="button" className="btn btn--primary" disabled={importing} onClick={() => void runImport()}>
          {importing ? '导入中…' : '导入 PDF'}
        </button>
      </header>

      {error && <div className="pdf-shelf__error">{error}</div>}

      {!hydrated ? (
        <div className="placeholder">
          <div className="spinner" />
        </div>
      ) : books.length === 0 ? (
        <div className="pdf-shelf__empty">还没有 PDF。点右上角导入一份。</div>
      ) : (
        <div className="pdf-shelf__list">
          {books.map((book) => (
            <div key={book.id} className="pdf-row">
              <button type="button" className="pdf-row__cover" onClick={() => setOpenBook(book)}>
                {covers[book.id] ? <img src={covers[book.id]!} alt="" /> : <span>PDF</span>}
              </button>
              <div className="pdf-row__meta">
                <button type="button" className="pdf-row__title" onClick={() => setOpenBook(book)}>
                  {book.title}
                </button>
                <span className="hint">
                  {String(book.meta.pages ?? '?')} 页
                  {book.progress ? ` · 读到第 ${(book.progress.section ?? 0) + 1} 页` : ''}
                </span>
              </div>
              <button type="button" className="btn btn--ghost" onClick={() => void runRemove(book)}>
                移除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ================= 阅读器 ================= */

interface ReaderProps {
  api: AppApi
  book: BookRecord
  dark: boolean
  onBack(): void
  onError(message: string): void
}

function PdfReader({ api, book, dark, onBack, onError }: ReaderProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const taskRef = useRef<PDFDocumentLoadingTask | null>(null)

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(1)
  const [zoom, setZoom] = useState(1.25)
  const [rendering, setRendering] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const path = await bookPath(api, book)
      const bytes = await api.fs.read(path)
      const task = pdfjs.getDocument({ data: bytes.slice() })
      taskRef.current = task
      const loaded = await task.promise
      if (cancelled) {
        void task.destroy()
        return
      }
      setDoc(loaded)
      const start = Math.min(Math.max(1, (book.progress?.section ?? 0) + 1), loaded.numPages)
      setPage(start)
    })().catch((err: unknown) => onError(err instanceof Error ? err.message : String(err)))

    return () => {
      cancelled = true
      void taskRef.current?.destroy()
      taskRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, api])

  // 渲染当前页
  useEffect(() => {
    if (!doc || !canvasRef.current) return
    let cancelled = false
    setRendering(true)

    void (async () => {
      const pdfPage = await doc.getPage(page)
      if (cancelled) return
      const base = pdfPage.getViewport({ scale: 1 })
      const viewport = pdfPage.getViewport({ scale: zoom * (window.devicePixelRatio || 1) })
      const canvas = canvasRef.current!
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      canvas.style.width = `${Math.ceil(base.width * zoom)}px`
      canvas.style.height = `${Math.ceil(base.height * zoom)}px`
      await pdfPage.render({ canvas, viewport }).promise
      if (!cancelled) {
        setRendering(false)
        if (page === 1) markPerf('PDF 首页出图')
      }
    })().catch((err: unknown) => {
      if (!cancelled) {
        setRendering(false)
        onError(err instanceof Error ? err.message : String(err))
      }
    })

    return () => {
      cancelled = true
    }
  }, [doc, page, zoom, onError])

  // 进度落盘（换页即存，PDF 翻页频率低，不需要节流）
  useEffect(() => {
    if (!doc) return
    void setProgress(api, book.id, {
      section: page - 1,
      fraction: 0,
      cfi: null,
      updatedAt: new Date().toISOString()
    })
  }, [api, book.id, page, doc])

  // 键盘翻页
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const total = doc?.numPages ?? 0
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        setPage((p) => Math.min(total, p + 1))
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        setPage((p) => Math.max(1, p - 1))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doc])

  const total = doc?.numPages ?? Number(book.meta.pages ?? 0)

  return (
    <div className={`pdf-reader${dark ? ' pdf-reader--dark' : ''}`}>
      <header className="pdf-reader__bar">
        <button type="button" className="btn btn--ghost" onClick={onBack}>
          ← 书架
        </button>
        <div className="pdf-reader__title" title={book.title}>
          {book.title}
        </div>
        <div className="row">
          <button type="button" className="btn btn--ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            上一页
          </button>
          <span className="pdf-reader__page">
            {page} / {total || '…'}
          </span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={page >= total}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => setZoom((z) => Math.max(ZOOM_MIN, Math.round((z - 0.25) * 100) / 100))}
          >
            −
          </button>
          <span className="pdf-reader__zoom">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="btn btn--ghost"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => setZoom((z) => Math.min(ZOOM_MAX, Math.round((z + 0.25) * 100) / 100))}
          >
            ＋
          </button>
        </div>
      </header>

      <div ref={wrapRef} className="pdf-reader__scroll">
        <canvas ref={canvasRef} className="pdf-reader__canvas" />
        {rendering && <div className="pdf-reader__busy">渲染中…</div>}
      </div>
    </div>
  )
}
