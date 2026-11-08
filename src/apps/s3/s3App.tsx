import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { S3Client } from '@aws-sdk/client-s3'
import type { AppApi } from '@airship/contract'
import { useAppAutotest, useTheme } from '@airship/sdk'
import { ConnectionCard } from './ConnectionCard.tsx'
import { ObjectsView } from './ObjectsView.tsx'
import { PreviewPane } from './PreviewPane.tsx'
import { SourceMenu } from './SourceMenu.tsx'
import {
  loadCurrent,
  loadSources,
  parseSource,
  saveCurrent,
  saveSources,
  type Source,
  type SourceInput
} from './connection.ts'
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
 * 顶部一条选项栏：当前是哪个源、连接设置、刷新、上传、新建桶。
 *
 * 一台机器上可以存好几个源（一家自建 RustFS、一家云 OSS……）：源排在顶栏那一排，
 * 源在前、「添加源」在最后，点一枚就换端点；「连接设置」改与删的都是当前这一个。
 *
 * 措辞是契约的一部分（见 `specs/s3.md`）：哪一句跟着哪个状态写死在这里，
 * 用例逐句比对，所以改一句话等于改一次契约。
 *
 * 一切网络请求由这个窗口自己发（清单里的 `net`），壳不代发也不改包里的东西。
 */
export default function S3App({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [sources, setSources] = useState<Source[]>([])
  const [current, setCurrent] = useState<Source | null>(null)
  const [buckets, setBuckets] = useState<BucketRow[]>([])
  const [bucket, setBucket] = useState<string | null>(null)
  const [prefix, setPrefix] = useState('')
  const [rows, setRows] = useState<ObjectRow[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [selected, setSelected] = useState<ObjectRow | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  /** 连接卡：开着没有、以及它这次是编辑哪一个源（null = 新增） */
  const [editing, setEditing] = useState(false)
  const [editTarget, setEditTarget] = useState<Source | null>(null)
  /** 顶栏那颗源键的面板 */
  const [menu, setMenu] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const client = useMemo(() => (current ? createClient(current) : null), [current])

  /** 列桶：换端点、换源、刷新、新建完都走这一条 */
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

  // 启动：设置里有源就直接连上次用的那一个，一个都没有就把连接卡摊开
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await loadSources(api)
      const wanted = await loadCurrent(api)
      if (cancelled) return
      if (stored.length === 0) {
        setEditing(true)
        return
      }
      setSources(stored)
      const chosen = stored.find((s) => s.name === wanted) ?? stored[0]!
      setCurrent(chosen)
      await refreshBuckets(createClient(chosen))
    })()
    return () => {
      cancelled = true
    }
  }, [api, refreshBuckets])

  /**
   * 截图模式的凭据：给一个本地路径，把它传到当前这一层，列表里看得见结果。
   *
   * `useAppAutotest` 只在挂载时注册一次 handler，闭包里的状态会停在首帧——
   * 首帧还没有源、也没有 client，所以这里每次都从 `live` 里取当下那一份。
   */
  const live = useRef({ client, bucket, buckets, openObjects })
  live.current = { client, bucket, buckets, openObjects }
  useAppAutotest(
    's3',
    async (path) => {
      // 主进程一等到"组件挂了监听"就推事件，那一刻第一次列桶往往还在路上；
      // 抢跑的结果是一句红字"这个端点上还没有桶"。等它把桶列出来，别猜时机。
      let now = live.current
      for (let i = 0; i < 100 && (!now.client || now.buckets.length === 0); i += 1) {
        await new Promise((r) => setTimeout(r, 50))
        now = live.current
      }
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

  /** 连接卡按下"连上"或"存下"：新增就是加一个源并切过去，编辑就是换掉当前那一份 */
  async function submitCard(input: SourceInput): Promise<void> {
    const taken = sources.filter((s) => s.name !== editTarget?.name).map((s) => s.name)
    const parsed = parseSource(input, taken)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    const next = parsed.source
    const list = sources.some((s) => s.name === editTarget?.name)
      ? sources.map((s) => (s.name === editTarget?.name ? next : s))
      : [...sources, next]

    setSources(list)
    setError('')
    setNote('')
    setEditing(false)
    setEditTarget(null)
    setBucket(null)
    setPrefix('')
    setRows([])
    setSelected(null)
    setCurrent(next)
    await saveSources(api, list)
    await saveCurrent(api, next.name)
    await refreshBuckets(createClient(next))
  }

  /** 换到那一排里的另一个源：桶、路径、预览整个跟着端点走 */
  async function pickSource(name: string): Promise<void> {
    const next = sources.find((s) => s.name === name)
    if (!next) return
    setEditing(false)
    setError('')
    setNote('')
    setBucket(null)
    setPrefix('')
    setRows([])
    setSelected(null)
    setCurrent(next)
    await saveCurrent(api, next.name)
    await refreshBuckets(createClient(next))
  }

  /** 删掉一个源（从连接卡里按）：这台机器上存的那把钥匙也跟着没了，所以先问一句 */
  async function removeSource(name: string): Promise<void> {
    if (!window.confirm(`删掉源「${name}」？这台机器上存的那把钥匙也跟着没了。`)) return
    const rest = sources.filter((s) => s.name !== name)
    setSources(rest)
    setError('')
    setNote(`已删掉源 ${name}`)
    await saveSources(api, rest)
    if (current?.name !== name) {
      // 删的不是当前这一个：卡收起来，顶栏那排少一枚
      setEditing(false)
      return
    }
    const next = rest[0] ?? null
    setCurrent(next)
    setBucket(null)
    setPrefix('')
    setRows([])
    setSelected(null)
    setEditTarget(null)
    if (next) {
      await saveCurrent(api, next.name)
      setEditing(false)
      await refreshBuckets(createClient(next))
      return
    }
    // 一个都不剩：这张卡转成"新增源"的样子，接着填下一个
    await saveCurrent(api, '')
    setEditing(true)
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
        <SourceMenu
          sources={sources}
          currentName={current?.name ?? ''}
          open={menu}
          onToggle={() => setMenu((v) => !v)}
          onPick={(name) => {
            setMenu(false)
            void pickSource(name)
          }}
          onAdd={() => {
            setMenu(false)
            setEditTarget(null)
            setEditing(true)
            setError('')
          }}
        />
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => {
            setMenu(false)
            setEditTarget(current)
            setEditing(true)
            setError('')
          }}
          disabled={current === null}
        >
          连接设置
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void refreshBuckets(client)} disabled={client === null || busy !== ''}>
          刷新
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void upload()} disabled={client === null || bucket === null || busy !== ''}>
          上传
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => setCreating(true)} disabled={client === null || creating}>
          新建桶
        </button>
        <span className="s3__busy">{busy !== '' ? busy : note}</span>
      </header>

      {creating ? (
        <div className="s3__newbucket">
          <label htmlFor="s3-newbucket">桶名</label>
          <input
            className="input"
            id="s3-newbucket"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submitNewBucket()}
            placeholder="my-bucket"
            autoFocus
          />
          <button type="button" className="btn btn--primary" onClick={() => void submitNewBucket()}>
            建
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      ) : null}

      {editing ? (
        <ConnectionCard
          key={editTarget?.name ?? 'new'}
          current={editTarget}
          error={error}
          busy={busy !== ''}
          onCancel={editTarget || current ? () => setEditing(false) : undefined}
          onRemove={editTarget ? () => void removeSource(editTarget.name) : undefined}
          onSubmit={(i) => void submitCard(i)}
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

/** 本地路径的最后一段：Windows 用反斜杠，POSIX 用正斜杠，两种都要认 */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}
