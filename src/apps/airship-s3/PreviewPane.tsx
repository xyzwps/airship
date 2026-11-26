import { useEffect, useState, type JSX } from 'react'
import type { AppApi } from '@airship/contract'
import { Icon } from '@iconify/react'
import { formatSize, formatTime } from './display.ts'
import type { ObjectMeta, ObjectRow } from './backendStore.ts'
import type { Source } from './connection.ts'
import { PREVIEW_MAX, makePreview, tooBigReason, type Preview } from './preview.ts'
import './icons.ts'

/**
 * 右侧那一栏：选中对象的详情与预览。
 *
 * 预览是"看一眼是不是这个文件"，不是文件管理器里的固定视图：
 * 没选中就不占地方，选中了才去取字节（取一次是一次递给后端的调用）。
 * 详情与字节是两次调用——超过上限的那一档只问详情，不去接那几十兆字节（判据 OS-019）。
 */
export function PreviewPane({
  api,
  conn,
  bucket,
  row,
  onClose
}: {
  api: AppApi
  conn: Source | null
  bucket: string
  row: ObjectRow | null
  onClose: () => void
}): JSX.Element | null {
  const [meta, setMeta] = useState<ObjectMeta | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!row || !conn) {
      setMeta(null)
      setPreview(null)
      setStatus('')
      return
    }
    let cancelled = false
    let objectUrl = ''
    setStatus('正在取详情…')
    void (async () => {
      try {
        const m = await api.backend.invoke<ObjectMeta>('head', { conn, bucket, key: row.key })
        if (cancelled) return
        setMeta(m)
        setStatus('')
        // 大小是详情里就有的数：超过上限就不去取那几十兆字节，直接说这一条不预览
        if (m.size > PREVIEW_MAX) {
          setPreview({ kind: 'none', reason: tooBigReason(m.size) })
          return
        }
        const bytes = await api.backend.invoke<Uint8Array>('getBytes', { conn, bucket, key: row.key })
        if (cancelled) return
        const p = makePreview(row.key, m.contentType, bytes)
        if (p.kind === 'image') objectUrl = p.url
        setPreview(p)
      } catch (e) {
        // 后端抛回来的已经是要念的那句中文，原样上屏
        if (!cancelled) setStatus(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
    }
  }, [api, conn, bucket, row])

  if (!row) return null

  return (
    <aside className="s3__pane">
      <div className="s3__pane-head">
        <span className="s3__pane-title">{row.label}</span>
        <button type="button" className="icon-btn" title="收起" aria-label="收起" onClick={onClose}>
          <Icon icon="lucide:x" width="16" height="16" aria-hidden="true" />
        </button>
      </div>
      <dl className="s3__meta">
        <dt>键</dt>
        <dd className="s3__key">{row.key}</dd>
        <dt>大小</dt>
        <dd>{formatSize(meta?.size ?? row.size)}</dd>
        <dt>类型</dt>
        <dd>{meta?.contentType === '' || meta === null ? '端点没写' : meta.contentType}</dd>
        <dt>改动时间</dt>
        <dd>{formatTime(meta?.lastModified ?? row.lastModified)}</dd>
      </dl>
      {status !== '' ? <p className="s3__status">{status}</p> : null}
      {preview?.kind === 'image' ? <img className="s3__preview-img" src={preview.url} alt={row.label} /> : null}
      {preview?.kind === 'text' ? <pre className="s3__preview-text">{preview.text}</pre> : null}
      {preview?.kind === 'none' ? <p className="s3__status">{preview.reason}</p> : null}
    </aside>
  )
}
