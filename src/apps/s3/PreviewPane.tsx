import { useEffect, useState, type JSX } from 'react'
import type { AppApi } from '@airship/contract'
import type { S3Client } from '@aws-sdk/client-s3'
import { errorText, formatSize, formatTime, getObjectBytes, headObject, type ObjectMeta, type ObjectRow } from './client.ts'
import { PREVIEW_MAX, makePreview, tooBigReason, type Preview } from './preview.ts'

/**
 * 右侧那一栏：选中对象的详情与预览。
 *
 * 预览是"看一眼是不是这个文件"，不是文件管理器里的固定视图：
 * 没选中就不占地方，选中了才去取字节（取一次是一次网络请求）。
 */
export function PreviewPane({
  api,
  client,
  bucket,
  row,
  onClose
}: {
  api: AppApi
  client: S3Client | null
  bucket: string
  row: ObjectRow | null
  onClose: () => void
}): JSX.Element | null {
  const [meta, setMeta] = useState<ObjectMeta | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!row || !client) {
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
        const m = await headObject(client, bucket, row.key)
        if (cancelled) return
        setMeta(m)
        setStatus('')
        // 大小是详情里就有的数：超过上限就不去取那几十兆字节，直接说这一条不预览
        if (m.size > PREVIEW_MAX) {
          setPreview({ kind: 'none', reason: tooBigReason(m.size) })
          return
        }
        const bytes = await getObjectBytes(client, bucket, row.key)
        if (cancelled) return
        const p = makePreview(row.key, m.contentType, bytes)
        if (p.kind === 'image') objectUrl = p.url
        setPreview(p)
      } catch (e) {
        if (!cancelled) setStatus(errorText(e))
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
    }
  }, [api, client, bucket, row])

  if (!row) return null

  return (
    <aside className="s3__pane">
      <div className="s3__pane-head">
        <span className="s3__pane-title">{row.label}</span>
        <button type="button" className="s3__ghost" onClick={onClose}>
          收起
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
