import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { S3Client } from '@aws-sdk/client-s3'
import type { AppApi } from '@airship/contract'
import { useAppAutotest, useTheme } from '@airship/sdk'
import { ConnectionCard } from './ConnectionCard.tsx'
import { ObjectsView } from './ObjectsView.tsx'
import { PreviewPane } from './PreviewPane.tsx'
import { loadConnection, parseConnection, saveConnection, type Connection, type ConnectionInput } from './connection.ts'
import {
  createClient,
  createBucket,
  deleteObject,
  errorText,
  listBuckets,
  listObjects,
  presignGet,
  validateBucketName,
  type BucketRow,
  type ObjectPage,
  type ObjectRow
} from './client.ts'
import { contentTypeOf, downloadObject, joinKey, uploadFile } from './transfer.ts'
import './s3.css'

/**
 * S3 —— 对象存储台。
 *
 * 三栏：左边一列桶，中间当前这一层的对象，右边选中那个对象的详情与预览。
 * 顶部一条选项栏：连的是哪个端点、连接设置、刷新、上传、新建桶。
 *
 * 措辞是契约的一部分（见 `specs/s3.md`）：哪一句跟着哪个状态写死在这里，
 * 用例逐句比对，所以改一句话等于改一次契约。
 *
 * 一切网络请求由这个窗口自己发（清单里的 `net`），壳不代发也不改包里的东西。
 */
export default function S3App({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [conn, setConn] = useState<Connection | null>(null)
  const [buckets, setBuckets] = useState<BucketRow[]>([])
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [rows, setRows] = useState<ObjectRow[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [selected, setSelected] = useState<ObjectRow | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const client = useMemo(() => (conn ? createClient(conn) : null), [conn])

  /** 列桶：换端点、刷新、新建完都走这一条 */
  const refreshBuckets = useCallback(async (next: S3Client | null): Promise<BucketRow[]> => {
    if (!next) return []
    setBusy('正在列桶…')
    setError('')
    try {
      const list = await listBuckets(next)
      setBuckets(list)
      return list
    } catch (e) {
      setError(errorText(e))
      setBuckets([])
      return []
    } finally {
      setBusy('')
    }
  }, [])

  /** 列当前这一层；`after` 给了就是"还有更多"往后接一页。把这一页交回去，自动凭据那侧要用 */
  const openObjects = useCallback(
    async (target: string, at: string, after?: string): Promise<ObjectPage | null> => {
      if (!client) return null
      setBusy('正在列对象…')
      setError('')
      try {
        const page = await listObjects(client, target, at, after)
        setRows((prev) => (after ? [...prev, ...page.rows] : page.rows))
        setToken(page.nextToken)
        return page
      } catch (e) {
        setError(errorText(e))
        if (!after) setRows([])
        return null
      } finally {
        setBusy('')
      }
    },
    [client]
  )

  // 启动：设置里存过就直接连上去，没存过就把连接卡摊开
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await loadConnection(api)
      if (cancelled) return
      if (!stored) {
        setEditing(true)
        return
      }
      setConn(stored)
      await refreshBuckets(createClient(stored))
    })()
    return () => {
      cancelled = true
    }
  }, [api, refreshBuckets])

  /**
   * 截图模式的凭据：给一个本地路径，把它传到当前这一层，列表里看得见结果。
   *
   * `useAppAutotest` 只在挂载时注册一次 handler，闭包里的状态会停在首帧——
   * 首帧还没有桶、也没有 client，所以这里每次都从 `live` 里取当下那一份。
   */
  const live = useRef({ client, bucket, buckets, openObjects })
  live.current = { client, bucket, buckets, openObjects }
  useAppAutotest(
    's3',
    async (path) => {
      const now = live.current
      const target = now.bucket ?? now.buckets[0]?.name ?? ''
      if (!now.client || target === '') throw new Error('这个端点上还没有桶')
      setBucket(target)
      setPrefix('')
      const name = baseName(path)
      await uploadFile(api, now.client, target, joinKey('', name), path, contentTypeOf(name))
      const page = await now.openObjects(target, '')
      const hit = page?.rows.find((r) => r.kind === 'object' && r.key === name)
      if (hit) setSelected(hit)
      setNote(`已上传 ${name}`)
    },
    (message) => setError(message)
  )

  async function connect(input: ConnectionInput): Promise<void> {
    const parsed = parseConnection(input)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setEditing(false)
    setError('')
    setNote('')
    setBucket(null)
    setPrefix('')
    setRows([])
    setSelected(null)
    setConn(parsed.conn)
    await saveConnection(api, parsed.conn)
    await refreshBuckets(createClient(parsed.conn))
  }

  function enterBucket(name: string): void {
    setBucket(name)
    setPrefix('')
    setSelected(null)
    void openObjects(name, '')
  }

  function enterPrefix(key: string): void {
    setPrefix(key)
    setSelected(null)
    void openObjects(bucket ?? '', key)
  }

  /** 面包屑：index 为 -1 是回到桶根，其余回到那一段 */
  function goCrumb(index: number): void {
    const at = index < 0 ? '' : trail.slice(0, index + 1).map((s) => `${s}/`).join('')
    setPrefix(at)
    setSelected(null)
    void openObjects(bucket ?? '', at)
  }

  async function upload(): Promise<void> {
    if (!client || bucket === null) return
    const picked = await api.dialog.openFiles({ title: '选要上传的文件', multiple: true })
    if (!picked || picked.length === 0) return
    setBusy(`正在上传 ${picked.length} 个…`)
    setError('')
    try {
      for (const path of picked) {
        const name = baseName(path)
        await uploadFile(api, client, bucket, joinKey(prefix, name), path, contentTypeOf(name), (done, total) => {
          setBusy(total > 1 ? `正在上传 ${name}（${done}/${total} 段）` : `正在上传 ${name}`)
        })
      }
      setNote(`已上传 ${picked.length} 个对象`)
      await openObjects(bucket, prefix)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function download(row: ObjectRow): Promise<void> {
    if (!client || bucket === null) return
    const dest = await api.dialog.saveFile({ title: '存到哪里', defaultPath: row.label })
    if (!dest) return
    setBusy(`正在下载 ${row.label}`)
    setError('')
    try {
      await downloadObject(api, client, bucket, row.key, dest)
      setNote(`已下载 ${row.label}`)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function copyLink(row: ObjectRow): Promise<void> {
    if (!client || bucket === null) return
    setError('')
    try {
      const url = await presignGet(client, bucket, row.key)
      await api.clipboard.writeText(url)
      setNote('临时链接已复制，一小时内有效')
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function remove(row: ObjectRow): Promise<void> {
    if (!client || bucket === null) return
    if (!window.confirm(`删掉 ${row.label}？端点上这份就没了。`)) return
    setError('')
    try {
      await deleteObject(client, bucket, row.key)
      if (selected?.key === row.key) setSelected(null)
      setNote(`已删掉 ${row.label}`)
      await openObjects(bucket, prefix)
    } catch (e) {
      setError(errorText(e))
    }
  }

  async function submitNewBucket(): Promise<void> {
    if (!client) return
    const bad = validateBucketName(newName)
    if (bad !== '') {
      setError(bad)
      return
    }
    setError('')
    setCreating(false)
    try {
      await createBucket(client, newName)
      setNewName('')
      setNote(`已建好桶 ${newName}`)
      await refreshBuckets(client)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const trail = useMemo(() => (prefix === '' ? [] : prefix.replace(/\/$/, '').split('/')), [prefix])

  return (
    <div className={`s3 s3--${resolved}`}>
      <header className="s3__bar">
        <span className="s3__endpoint">{conn ? hostOf(conn.endpoint) : '还没连上任何端点'}</span>
        <button type="button" className="s3__ghost" onClick={() => setEditing(true)}>
          连接设置
        </button>
        <button type="button" className="s3__ghost" onClick={() => void refreshBuckets(client)} disabled={client === null || busy !== ''}>
          刷新
        </button>
        <button type="button" className="s3__ghost" onClick={() => void upload()} disabled={client === null || bucket === null || busy !== ''}>
          上传
        </button>
        <button type="button" className="s3__ghost" onClick={() => setCreating(true)} disabled={client === null || creating}>
          新建桶
        </button>
        <span className="s3__busy">{busy !== '' ? busy : note}</span>
      </header>

      {creating ? (
        <div className="s3__newbucket">
          <label htmlFor="s3-newbucket">桶名</label>
          <input
            id="s3-newbucket"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitNewBucket()}
            placeholder="my-bucket"
            autoFocus
          />
          <button type="button" className="s3__go" onClick={() => void submitNewBucket()}>
            建
          </button>
          <button type="button" className="s3__ghost" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      ) : null}

      {editing ? (
        <ConnectionCard
          current={conn}
          error={error}
          busy={busy !== ''}
          onCancel={conn ? () => setEditing(false) : undefined}
          onSubmit={(i) => void connect(i)}
        />
      ) : null}

      {error !== '' && !editing ? <div className="s3__error">{error}</div> : null}

      <div className="s3__body">
        <nav className="s3__buckets">
          <div className="s3__pane-title">桶</div>
          {client !== null && busy === '' && error === '' && buckets.length === 0 ? (
            <p className="s3__empty">这个端点上还没有桶</p>
          ) : null}
          <ul className="s3__bucket-list">
            {buckets.map((b) => (
              <li key={b.name}>
                <button type="button" className={`s3__bucket${b.name === bucket ? ' s3__bucket--on' : ''}`} data-test={`bucket:${b.name}`} onClick={() => enterBucket(b.name)}>
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {bucket === null ? (
          <section className="s3__objects">
            <p className="s3__empty">左边选一个桶，这里就列出它的对象。</p>
          </section>
        ) : (
          <ObjectsView
            bucket={bucket}
            prefix={prefix}
            trail={trail}
            rows={rows}
            hasMore={token !== null}
            busy={busy !== ''}
            selectedKey={selected?.key ?? null}
            onEnterPrefix={enterPrefix}
            onCrumb={goCrumb}
            onUp={() => goCrumb(trail.length - 2)}
            onMore={() => void openObjects(bucket, prefix, token ?? undefined)}
            onSelect={(r) => setSelected(r)}
            onDownload={(r) => void download(r)}
            onCopyLink={(r) => void copyLink(r)}
            onDelete={(r) => void remove(r)}
          />
        )}

        <PreviewPane api={api} client={client} bucket={bucket ?? ''} row={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  )
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}

/** 本地路径的最后一段：Windows 用反斜杠，POSIX 用正斜杠，两种都要认 */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}
