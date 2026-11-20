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
  COPY_SOURCE_LIMIT,
  copyObject,
  copyTooBigText,
  createBucket,
  createClient,
  deleteObject,
  dirMarkerExists,
  errorText,
  listBuckets,
  listObjects,
  presignGet,
  putDirMarker,
  validateBucketName,
  validateDirName,
  validateRename,
  type BucketRow,
  type ObjectPage,
  type ObjectRow
} from './client.ts'
import { contentTypeOf, downloadObject, joinKey, sourceFromFile, sourceFromPath, uploadLocal, type ByteSource } from './transfer.ts'
import './s3.css'

/**
 * S3 —— 对象存储台。
 *
 * 三栏：左边一列桶，中间当前这一层的对象，右边选中那个对象的详情与预览。
 * 顶部一条选项栏：当前是哪个源、连接设置、刷新、上传、新建桶、新建目录。
 *
 * 拖进来松手与「上传」那颗键是同一条路：落点都是当前那一层（判据见 `specs/s3.md` OS-041~045）。
 * 拖放听在窗口上而不是某一栏上，因为不接住的话 Electron 会自己去打开那个文件——整扇界面就没了。
 *
 * 连接卡与改名模态都是居中模态（盖在三栏之上）：那五个格子摊在栏下会把三栏整体往下推，
 * 而填一次连接是"改设置"那类动作，本来就该跟眼前的对象表隔开。
 * 改名从前走顶栏下面的内联条——离被点的那一行太远，2026-11-20 按实拍换成同一形状的模态（OS-046~051）。
 *
 * 一台机器上可以存好几个源（一家自建 RustFS、一家云 OSS……）：源排在顶栏那一排，
 * 源在前、「添加源」在最后，点一枚就换端点；「连接设置」改与删的都是当前这一个。
 *
 * 措辞是契约的一部分（见 `specs/s3.md`）：哪一句跟着哪个状态写死在这里，
 * 用例逐句比对，所以改一句话等于改一次契约。
 *
 * 一切网络请求由这个窗口自己发（清单里的 `net`），runtime 不代发也不改包里的东西。
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
  /** 顶栏下面那条内联条：开着没有、这次是建桶还是建目录 */
  const [creating, setCreating] = useState(false)
  const [newKind, setNewKind] = useState<'bucket' | 'dir'>('bucket')
  const [newName, setNewName] = useState('')
  /** 重命名模态：这次改的是哪一行（null = 没摊开）、格子里的新名字 */
  const [renaming, setRenaming] = useState<ObjectRow | null>(null)
  const [renameName, setRenameName] = useState('')
  /** 拖着一份文件停在窗口里、还没松手时念的那句落点；空串就是没在拖 */
  const [dropHint, setDropHint] = useState('')

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
  const live = useRef({ client, bucket, buckets, prefix, editing, renaming, openObjects })
  live.current = { client, bucket, buckets, prefix, editing, renaming, openObjects }
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
      await uploadLocal(
        now.client,
        target,
        joinKey('', name),
        await sourceFromPath(api, path),
        contentTypeOf(name)
      )
      const page = await now.openObjects(target, '')
      const hit = page?.rows.find((r) => r.kind === 'object' && r.key === name)
      if (hit) setSelected(hit)
      setNote(`已上传 ${name}`)
    },
    (message) => setError(message)
  )

  /**
   * 拖进来松手那一族：听在窗口上，而不是某一栏上。
   *
   * 为什么必须整个接住：Electron 对没被接住的文件拖放，默认动作是"把这扇窗口导航到那个文件"，
   * 整张界面会凭空换成一份文件。所以不认的情况也照样什么都不做（连接卡摊着时就是这一档，OS-044）。
   *
   * 监听只挂一次，闭包会停在首帧——那一刻还没有源也没有桶，所以落点一律从 `live` 里取当下那一份。
   */
  useEffect(() => {
    /** 悬停那一下只能问出"这一拖里有没有文件"（浏览器要到松手才把 files 交出来） */
    const dragsFiles = (dt: DataTransfer | null): dt is DataTransfer =>
      dt !== null && Array.from(dt.types).includes('Files')
    /** 落点那句话里要念的那一段；还没得传的时候是空串（模态摊着时也是——往背后传东西没人会看见） */
    function landing(): string {
      const now = live.current
      if (now.editing || now.renaming !== null || now.client === null || now.bucket === null) return ''
      return now.prefix === '' ? `${now.bucket} 根下` : `${now.bucket}/${now.prefix}`
    }
    function onDragOver(e: DragEvent): void {
      const dt = e.dataTransfer
      if (!dragsFiles(dt)) return
      // 不挡下 dragover，Chromium 就不认为这里能落，drop 根本不会发生
      e.preventDefault()
      dt.dropEffect = 'copy'
      const at = landing()
      setDropHint(at === '' ? '' : `松手就传到 ${at}`)
    }
    function onDragLeave(e: DragEvent): void {
      // relatedTarget 为空才是真出了这扇窗口；在子元素之间挪是 dragleave→dragover 成对来的，别跟着闪
      if (e.relatedTarget === null) setDropHint('')
    }
    function onDrop(e: DragEvent): void {
      const dt = e.dataTransfer
      if (dt === null) return
      const files = Array.from(dt.files)
      // 松手时交出来的这批就是载荷；一段文字、一个链接那种什么都不传，也不替窗口做主
      if (files.length === 0) return
      e.preventDefault()
      setDropHint('')
      void putDropped(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

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

  /**
   * 一批本地来源传到某一层。
   *
   * 「上传」那颗键选来的路径与拖进来松手的那几颗都走这一条：落点都是按下那一下眼前的那一层，
   * 回执也是那一句（册子 OS-012 与 OS-042 比的是同一句话）。
   */
  async function putAll(
    target: { client: S3Client; bucket: string; at: string },
    items: Array<{ name: string; open: () => Promise<ByteSource> }>
  ): Promise<void> {
    setBusy(`正在上传 ${items.length} 个…`)
    setError('')
    try {
      for (const it of items) {
        const source = await it.open()
        await uploadLocal(
          target.client,
          target.bucket,
          joinKey(target.at, it.name),
          source,
          contentTypeOf(it.name),
          (done, total) => {
            setBusy(total > 1 ? `正在上传 ${it.name}（${done}/${total} 段）` : `正在上传 ${it.name}`)
          }
        )
      }
      setNote(`已上传 ${items.length} 个对象`)
      // 从窗口监听里进来时，这一条链上的闭包停在首帧——那一刻还没有 client，
      // 首帧那份 openObjects 会直接返回 null，列表就永远停在拖进来之前的样子。取当下的那一份。
      await live.current.openObjects(target.bucket, target.at)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  async function upload(): Promise<void> {
    if (!client || bucket === null) return
    const picked = await api.dialog.openFiles({ title: '选要上传的文件', multiple: true })
    if (!picked || picked.length === 0) return
    await putAll(
      { client, bucket, at: prefix },
      picked.map((path) => ({ name: baseName(path), open: () => sourceFromPath(api, path) }))
    )
  }

  /**
   * 拖进来松手那一下。
   *
   * 没选桶就把缺的那一步说出来；连接卡或改名模态摊着时什么都不动——眼前正等着填东西，
   * 这时候往背后传东西没人会看见（册子 OS-043 与 OS-044）。
   */
  async function putDropped(files: File[]): Promise<void> {
    const now = live.current
    if (files.length === 0 || now.editing || now.renaming !== null) return
    if (now.client === null || now.bucket === null) {
      setError('左边先选一个桶，拖进来的文件才有落点')
      return
    }
    await putAll(
      { client: now.client, bucket: now.bucket, at: now.prefix },
      files.map((file) => ({ name: file.name, open: async () => sourceFromFile(file) }))
    )
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

  /**
   * 行尾那颗重命名键：摊开居中的改名模态，格子里预填当前名字。
   *
   * 从前是顶栏下面那条内联条——离被点的行太远，2026-11-20 按实拍换成模态（OS-046~051）。
   * 超上限的对象在摊模态之前就拒（判据 OS-049）：那一份要改走得是分段复制那一整套，
   * 这个应用不接，让人填完名字才被拒更糟。
   */
  function startRename(row: ObjectRow): void {
    setError('')
    if (row.size > COPY_SOURCE_LIMIT) {
      setError(copyTooBigText(row.size))
      return
    }
    setRenaming(row)
    setRenameName(row.label)
  }

  function closeRename(): void {
    setRenaming(null)
    setRenameName('')
  }

  /**
   * 重命名 = 服务端复制到新键、再删旧键——S3 没有改名这一条操作，这是唯一有接口的一族（OS-046）。
   *
   * 目录与桶不提供：非空目录没有整目录改名的接口，只把那个零字节标记改走会把里面的对象
   * 留在旧前缀下，比不改更骗人；桶更是连"换个名字"的操作都没有（OS-050）。
   * 同名与形状不合都在本地先判——CopyObject 对已存在的目标不拒绝，它会直接盖上去。
   */
  async function submitRename(): Promise<void> {
    if (!client || bucket === null || renaming === null) return
    const row = renaming
    // 同名那一档比的是这一层里已经列出来的对象行（不含自己）
    const siblings = rows.filter((r) => r.kind === 'object' && r.key !== row.key).map((r) => r.label)
    const bad = validateRename(renameName, row.label, siblings)
    if (bad !== '') {
      setError(bad)
      return
    }
    const name = renameName
    const oldLabel = row.label
    setError('')
    closeRename()
    setBusy(`正在重命名 ${oldLabel}…`)
    try {
      const newKey = joinKey(prefix, name)
      await copyObject(client, bucket, row.key, newKey)
      await deleteObject(client, bucket, row.key)
      if (selected?.key === row.key) setSelected(null)
      setNote(`已重命名 ${oldLabel} → ${name}`)
      await openObjects(bucket, prefix)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
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

  /** 建目录 = 存一个以 `/` 结尾的零字节对象；有了它，空的那一格才在列表里占得住一行 */
  async function submitNewDir(): Promise<void> {
    if (!client || bucket === null) return
    // 同名那一档比的是这一层里已经列出来的目录行（端点侧没有"目录已存在"这种拒绝）
    const siblings = rows.filter((r) => r.kind === 'prefix').map((r) => r.label.replace(/\/$/, ''))
    const bad = validateDirName(newName, siblings)
    if (bad !== '') {
      setError(bad)
      return
    }
    const name = newName
    setError('')
    setCreating(false)
    try {
      await putDirMarker(client, bucket, joinKey(prefix, `${name}/`))
      setNewName('')
      setNote(`已建好目录 ${name}`)
      await openObjects(bucket, prefix)
    } catch (e) {
      setError(errorText(e))
    }
  }

  /**
   * 删掉一个目录行 = 只去掉那个目录标记。
   *
   * 先问端点上有没有标记：由对象聚合成的一行（比如只有 `logs/x.txt` 时的 `logs/`）没有标记可删，
   * 这时候一句都不能删——否则用户以为那一格里的东西没了。
   * 删完之后按"这一行还在不在"决定念哪句：里面还挂着对象的，行会因为聚合而留下来。
   */
  async function removeDir(row: ObjectRow): Promise<void> {
    if (!client || bucket === null) return
    const name = row.label.replace(/\/$/, '')
    setError('')
    try {
      if (!(await dirMarkerExists(client, bucket, row.key))) {
        setError(`${name} 是从里面的对象读出来的目录，没有单独的标记可删`)
        return
      }
      if (!window.confirm(`删掉目录 ${name}？只去掉这个目录标记，里面已有的对象不动。`)) return
      await deleteObject(client, bucket, row.key)
      const page = await openObjects(bucket, prefix)
      const stillThere = (page?.rows ?? []).some((r) => r.kind === 'prefix' && r.key === row.key)
      setNote(
        stillThere
          ? `已去掉 ${name} 的目录标记，里面还有对象，这一行还在`
          : `已删掉目录 ${name}`
      )
    } catch (e) {
      setError(errorText(e))
    }
  }

  /** 那条内联条：建桶与建目录共用一条形状，同一时刻只摊得开一种 */
  function openBar(kind: 'bucket' | 'dir'): void {
    setNewKind(kind)
    setNewName('')
    setError('')
    setCreating(true)
  }

  /** 连接卡收得掉收不掉：一个源都没有时收起来就什么都点不到了 */
  const cardClosable = editTarget !== null || current !== null
  function closeCard(): void {
    if (cardClosable) setEditing(false)
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
        <button type="button" className="btn btn--ghost" onClick={() => openBar('bucket')} disabled={client === null || creating}>
          新建桶
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={() => openBar('dir')}
          disabled={client === null || bucket === null || creating}
        >
          新建目录
        </button>
        <span className="s3__busy">{busy !== '' ? busy : note}</span>
      </header>

      {creating ? (
        <div className="s3__newbucket">
          <label htmlFor={newKind === 'bucket' ? 's3-newbucket' : 's3-newdir'}>
            {newKind === 'bucket' ? '桶名' : '目录名'}
          </label>
          <input
            className="input"
            id={newKind === 'bucket' ? 's3-newbucket' : 's3-newdir'}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void (newKind === 'bucket' ? submitNewBucket() : submitNewDir())}
            placeholder={newKind === 'bucket' ? 'my-bucket' : 'pics'}
            autoFocus
          />
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void (newKind === 'bucket' ? submitNewBucket() : submitNewDir())}
          >
            建
          </button>
          <button type="button" className="btn btn--ghost" onClick={() => setCreating(false)}>
            取消
          </button>
        </div>
      ) : null}

      {editing ? (
        <div className="s3__modal">
          {/* 外面那层就是"卡片之外"：点它等于收起（一个源都没有时收起就什么都点不到了，所以不收） */}
          <div className="s3__modal-backdrop" data-test="modal-backdrop" onClick={closeCard} />
          <section
            className="s3__modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="连接设置"
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeCard()
            }}
          >
            <ConnectionCard
              key={editTarget?.name ?? 'new'}
              current={editTarget}
              error={error}
              busy={busy !== ''}
              onCancel={cardClosable ? () => setEditing(false) : undefined}
              onRemove={editTarget ? () => void removeSource(editTarget.name) : undefined}
              onSubmit={(i) => void submitCard(i)}
            />
          </section>
        </div>
      ) : null}

      {renaming !== null ? (
        <div className="s3__modal">
          {/* 与连接卡同一套收法：Esc 或点外面那层就收起，这一次改动什么都没发生（OS-051） */}
          <div className="s3__modal-backdrop" data-test="rename-backdrop" onClick={closeRename} />
          <section
            className="s3__modal-panel"
            role="dialog"
            aria-modal="true"
            aria-label="重命名"
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeRename()
            }}
          >
            <div className="s3__card">
              <p className="s3__rename-from">把 {bucket}/{renaming.key} 改成：</p>
              <div className="s3__fields">
                <div className="s3__field">
                  <label htmlFor="s3-rename">新名字</label>
                  <input
                    className="input"
                    id="s3-rename"
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void submitRename()}
                    autoFocus
                  />
                </div>
              </div>
              {error !== '' ? <p className="s3__error">{error}</p> : null}
              <div className="s3__card-foot">
                <button type="button" className="btn btn--primary" disabled={busy !== ''} onClick={() => void submitRename()}>
                  改
                </button>
                <button type="button" className="btn btn--ghost" onClick={closeRename}>
                  取消
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {error !== '' && !editing && renaming === null ? <div className="s3__error">{error}</div> : null}

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
            onRename={(r) => startRename(r)}
            onDelete={(r) => void remove(r)}
            onDeleteDir={(r) => void removeDir(r)}
          />
        )}

        <PreviewPane api={api} client={client} bucket={bucket ?? ''} row={selected} onClose={() => setSelected(null)} />
      </div>

      {/* 拖进来还没松手时盖在整窗上的那一句落点：只说，不吃鼠标——事件本来就听在窗口上 */}
      {dropHint !== '' ? <div className="s3__dropzone">{dropHint}</div> : null}
    </div>
  )
}

/** 本地路径的最后一段：Windows 用反斜杠，POSIX 用正斜杠，两种都要认 */
function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i < 0 ? path : path.slice(i + 1)
}
