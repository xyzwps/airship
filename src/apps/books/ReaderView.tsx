import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type JSX
} from 'react'
// 注册 <foliate-view> 自定义元素；makeBook 负责按文件头识别 EPUB / MOBI / FB2
import 'foliate-js/view.js'
import { makeBook } from 'foliate-js/view.js'
import type { AppApi } from '@shared/protocol'
import { bookPath, type BookProgress, type BookRecord } from '@shared/library'
import { remoteFile } from './remoteFile'
import { decodeText } from '@shared/textdecode'
import { makeTextBook, txtToHtml, type BookTheme } from './txtBook'

/**
 * foliate-js 阅读器视图。
 *
 * 和 RN 版的差别：RN 版把这套逻辑放在独立 webview 里、靠 base64 消息桥取字节；
 * Electron 里渲染进程本来就有完整 DOM，直接内嵌，取字节走 IPC 返回 Uint8Array。
 * 翻页输入（方向键 / 空格 / 滚轮）的绑定逻辑原样继承，包括滚轮额度上限那个坑
 * （窗口失焦时滚轮事件会积压，重获焦点一次性倾泻会一路翻回书首）。
 */

interface FoliateView extends HTMLElement {
  book?: {
    toc?: unknown[]
    metadata?: { title?: unknown; author?: unknown; language?: unknown }
    sections?: unknown[]
  }
  renderer?: {
    setStyles?(styles: Record<string, string>): void
    getContents?(): { doc?: Document }[]
    addEventListener(type: string, fn: (e: CustomEvent) => void): void
  }
  lastLocation?: { cfi?: string; tocItem?: { label?: unknown; href?: unknown } }
  open(book: unknown): Promise<void>
  close?(): void
  next(): Promise<void> | void
  prev(): Promise<void> | void
  goTo(target: unknown): Promise<void> | void
  goToFraction(f: number): Promise<void> | void
  addEventListener(type: string, fn: (e: Event) => void): void
}

export interface ReaderHandle {
  next(): void
  prev(): void
  goTo(target: unknown): void
  goToFraction(fraction: number): void
}

export interface TocItem {
  label: string
  href: string
  depth: number
}

interface Props {
  api: AppApi
  book: BookRecord
  theme: BookTheme
  fontScale: number
  onProgress(progress: BookProgress): void
  onToc(items: TocItem[]): void
  onReady(sectionCount: number): void
  onError(message: string): void
}

const NEXT_KEYS: Record<string, 1> = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1 }
const PREV_KEYS: Record<string, 1> = { ArrowLeft: 1, ArrowUp: 1, PageUp: 1, Backspace: 1 }

const WHEEL_STEP = 110
const WHEEL_GAP = 220
const WHEEL_CAP = WHEEL_STEP * 3

function labelOf(value: unknown, language: string | null): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const map = value as Record<string, unknown>
    const preferred = language ? map[language] : undefined
    if (typeof preferred === 'string') return preferred
    for (const candidate of Object.values(map)) {
      if (typeof candidate === 'string') return candidate
    }
  }
  return ''
}

function flattenToc(items: unknown, depth = 0, out: TocItem[] = [], language: string | null = null): TocItem[] {
  for (const raw of (items ?? []) as { label?: unknown; href?: unknown; subitems?: unknown }[]) {
    out.push({
      label: labelOf(raw.label, language),
      href: raw.href != null ? String(raw.href) : '',
      depth
    })
    if (raw.subitems && Array.isArray(raw.subitems) && raw.subitems.length) {
      flattenToc(raw.subitems, depth + 1, out, language)
    }
  }
  return out
}

export const ReaderView = forwardRef<ReaderHandle, Props>(function ReaderView(
  { api, book, theme, fontScale, onProgress, onToc, onReady, onError },
  ref
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateView | null>(null)
  const stateRef = useRef({ fontScale, theme })
  stateRef.current = { fontScale, theme }

  const applyStyles = (): void => {
    const { fontScale: scale, theme: t } = stateRef.current
    viewRef.current?.renderer?.setStyles?.({
      'font-size': `${Math.round(19 * scale)}px`,
      'line-height': '1.5',
      'text-align': 'initial',
      color: t.ink,
      'background-color': t.paper
    })
  }

  useImperativeHandle(ref, () => ({
    next: () => void viewRef.current?.next(),
    prev: () => void viewRef.current?.prev(),
    goTo: (target) => void viewRef.current?.goTo(target),
    goToFraction: (f) => void viewRef.current?.goToFraction(f)
  }))

  useEffect(() => {
    applyStyles()
  }, [fontScale, theme.ink, theme.paper])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let cancelled = false
    let view: FoliateView | null = null
    let wheelAcc = 0
    let wheelTimer: ReturnType<typeof setTimeout> | null = null

    const stopWheelDrain = (): void => {
      if (wheelTimer) {
        clearTimeout(wheelTimer)
        wheelTimer = null
      }
    }

    const paging = (): boolean => Boolean(view)

    const drainWheel = (): void => {
      if (!paging()) {
        wheelAcc = 0
        stopWheelDrain()
        return
      }
      if (Math.abs(wheelAcc) < WHEEL_STEP) {
        stopWheelDrain()
        return
      }
      const forward = wheelAcc > 0
      wheelAcc -= forward ? WHEEL_STEP : -WHEEL_STEP
      void (forward ? view!.next() : view!.prev())
      wheelTimer = setTimeout(drainWheel, WHEEL_GAP)
    }

    const bindKeys = (doc: Document | null): void => {
      if (!doc || (doc as Document & { __airshipKeys?: boolean }).__airshipKeys) return
      ;(doc as Document & { __airshipKeys?: boolean }).__airshipKeys = true

      doc.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return
        if (!paging()) return
        const forward = NEXT_KEYS[event.key] === 1
        if (!forward && PREV_KEYS[event.key] !== 1) return
        event.preventDefault()
        stopWheelDrain()
        wheelAcc = 0
        void (forward ? view!.next() : view!.prev())
      })

      doc.addEventListener(
        'wheel',
        (event) => {
          if (!paging()) return
          const hostWin = (event.view?.top ?? window) as Window & { __airshipWheelSeen?: WeakSet<object> }
          hostWin.__airshipWheelSeen ??= new WeakSet()
          if (hostWin.__airshipWheelSeen.has(event)) return
          hostWin.__airshipWheelSeen.add(event)

          const step = Math.abs(event.deltaY)
          if (step < 8) return
          event.preventDefault()
          if (wheelAcc !== 0 && Math.sign(wheelAcc) !== Math.sign(event.deltaY)) {
            wheelAcc = 0
            stopWheelDrain()
          }
          wheelAcc = Math.max(-WHEEL_CAP, Math.min(WHEEL_CAP, wheelAcc + event.deltaY))
          if (!wheelTimer) drainWheel()
        },
        { passive: false }
      )
    }

    const open = async (): Promise<void> => {
      view = document.createElement('foliate-view') as FoliateView
      viewRef.current = view
      host.append(view)

      // 必须在 open 之前绑：节文档的 load 事件在 open 过程中就开始触发
      view.addEventListener('load', (e) => {
        const detail = (e as CustomEvent).detail as { doc?: Document } | undefined
        bindKeys(detail?.doc ?? null)
      })

      bindKeys(document)

      const path = await bookPath(api, book)

      if (book.format === 'epub' || book.format === 'mobi') {
        const file = remoteFile(api, path, book.size, book.title)
        await view.open(file)
      } else {
        const bytes = await api.fs.read(path)
        const text = decodeText(bytes)
        const bodyHtml =
          book.format === 'txt' ? txtToHtml(text) : (new DOMParser().parseFromString(text, 'text/html').body?.innerHTML ?? text)
        await view.open(makeTextBook({ title: book.title, bodyHtml, theme: stateRef.current.theme }))
      }

      if (cancelled) return

      view.renderer?.addEventListener('relocate', (e) => {
        const detail = e.detail as { index?: number; fraction?: number }
        const cfi = view?.lastLocation?.cfi ?? null
        onProgress({
          section: detail.index ?? 0,
          fraction: detail.fraction ?? 0,
          cfi,
          updatedAt: new Date().toISOString()
        })
      })

      applyStyles()

      const language =
        typeof view.book?.metadata?.language === 'string'
          ? (view.book.metadata.language as string)
          : (Object.keys((view.book?.metadata?.language ?? {}) as object)[0] ?? null)
      onToc(flattenToc(view.book?.toc, 0, [], language))

      const target = book.progress?.cfi ?? book.progress?.section ?? 0
      await Promise.resolve(view.goTo(target)).catch(() => undefined)

      if (!cancelled) onReady(view.book?.sections?.length ?? 0)
    }

    open().catch((err: unknown) => {
      if (!cancelled) onError(err instanceof Error ? err.message : String(err))
    })

    return () => {
      cancelled = true
      stopWheelDrain()
      view?.close?.()
      view?.remove()
      viewRef.current = null
    }
    // 只在换书时重开；字号/主题走 applyStyles，不重建 view
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book.id, api])

  return <div ref={hostRef} className="reader-view selectable" />
})
