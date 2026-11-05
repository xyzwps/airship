import type { AppApi } from '@shared/protocol'

/**
 * 壳级共享书库——一个按外部依赖规则管理的共享包。
 *
 * 规则（见 docs/architecture.md §8）：
 *   1. 单一入口：外部只 import `@shared/library`，不摸包内文件。
 *   2. 契约带版本：公开 API 变更要升 `LIBRARY_API_VERSION`；
 *      持久结构自己也有 version（library.json 里那个）。
 *   3. 不含消费者专有概念：包内不许出现"只有某个应用才有的字段"。
 *   4. 消费者由声明决定：应用在自己的清单里写 sharedNamespaces: ['library']。
 *
 * 数据落在 userData/shared/library/：
 *   library.json        书目索引
 *   files/<id><ext>     书的本体（导入时拷进来，不依赖用户原路径还活着）
 *   covers/<id>.<ext>   封面图
 *
 * 书库只负责"存"和"索引"。元数据和封面由导入方提供：
 * books 用 foliate-js 读 EPUB/MOBI 的 metadata 与封面，
 * pdf 用 pdfjs-dist 数页数、渲染第一页当封面。
 * 这样书库不绑任何渲染库，两个应用谁先导入都行。
 */

export const LIBRARY_API_VERSION = 1

/** 格式是书库自己的领域概念（它就是个书库），不算消费者专有 */
export type BookFormat = 'epub' | 'mobi' | 'txt' | 'pdf'

/**
 * 每本书的附加信息。
 *
 * 刻意做成开放键值而不是给每个格式加一个专属字段：
 * pdf 有 pages、foliate 系有 sections，将来别的格式还有别的。
 * 一旦在 BookRecord 上写 `pages`，这个包就开始替 pdf 一个应用说话了。
 * 键名由各应用自己维护，本包只保证存得下、读得出。
 */
export type BookMeta = Record<string, number | string>

export interface BookProgress {
  /** 节序号（foliate 的 section index / pdf 的页号） */
  section: number
  /** 节内进度 0~1 */
  fraction: number
  /** EPUB 的 CFI，续读优先用它；拿不到就退回 section+fraction */
  cfi: string | null
  updatedAt: string
}

export interface BookRecord {
  id: string
  title: string
  author: string
  format: BookFormat
  /** 相对书库根目录：files/<id><ext> */
  file: string
  /** 相对书库根目录：covers/<id>.<ext>，无封面为 null */
  cover: string | null
  size: number
  addedAt: string
  progress: BookProgress | null
  /** 附加信息，见 BookMeta */
  meta: BookMeta
}

interface LibraryFile {
  version: number
  books: BookRecord[]
}

/**
 * 持久结构版本。
 *
 * v1 → v2：BookRecord 的 `pages`（pdf 专有）换成通用 `meta`。
 * 不做静默迁移，也不写兼容字段——版本对不上就明确报错，
 * 让"删掉 shared/library/library.json 重新导入"成为唯一出路。
 * 迁移代码是长期负债，自用阶段不值得背。
 */
const DATA_VERSION = 2

const INDEX = 'library.json'

let writeQueue: Promise<void> = Promise.resolve()

function root(api: AppApi): Promise<string> {
  return api.fs.resolveInShared('library')
}

function indexPath(api: AppApi): Promise<string> {
  return api.fs.resolveInShared('library', INDEX)
}

export async function loadBooks(api: AppApi): Promise<BookRecord[]> {
  const path = await indexPath(api)
  const stat = await api.fs.stat(path)
  if (!stat) return []
  const bytes = await api.fs.read(path)
  const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as Partial<LibraryFile>
  if (!parsed || !Array.isArray(parsed.books)) throw new Error('书库索引格式不正确')

  if (parsed.version !== DATA_VERSION) {
    throw new Error(
      `书库索引是 v${parsed.version ?? '?'}，本包只认 v${DATA_VERSION}。` +
        '删掉 userData/shared/library/library.json 后重新导入书籍即可（书本体和封面不用动）。'
    )
  }

  return parsed.books.filter((b): b is BookRecord => Boolean(b && typeof b.id === 'string'))
}

export function saveBooks(api: AppApi, books: BookRecord[]): Promise<void> {
  const pending = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const path = await indexPath(api)
      const file: LibraryFile = { version: DATA_VERSION, books }
      await api.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
    })
  writeQueue = pending.catch(() => undefined)
  return pending
}

export function bookPath(api: AppApi, book: BookRecord): Promise<string> {
  return api.fs.resolveInShared('library', book.file)
}

/**
 * 封面转成能直接给 `<img>` 用的地址。
 *
 * 走"经壳读字节 → blob: URL"而不是拼一个 `file:///` 地址：应用窗口的 CSP 只放行
 * `'self' blob: data:`，而页面本身是 `file://` 加载的——Chromium 不把 `file:` 子资源算作
 * `'self'`，拼出来的地址会被拦下来，书架上就是一座破图。
 * 走 blob 也就不用为了显示封面去放宽渲染侧的文件访问，数据仍然只由壳递出来。
 *
 * 同一张图按共享区里的位置缓存：书架每次刷新都重新取一遍地址，不该每次都读盘。
 */
const coverCache = new Map<string, string>()

const COVER_MIME: Record<string, string> = {
  png: 'image/png',
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif'
}

export async function coverUrl(api: AppApi, book: BookRecord): Promise<string | null> {
  if (!book.cover) return null
  const cached = coverCache.get(book.cover)
  if (cached) return cached

  const path = await api.fs.resolveInShared('library', book.cover)
  const bytes = await api.fs.read(path)
  const ext = book.cover.split('.').pop()?.toLowerCase() ?? 'jpg'
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: COVER_MIME[ext] ?? 'image/jpeg' }))
  coverCache.set(book.cover, url)
  return url
}

export interface AddBookInput {
  sourcePath: string
  format: BookFormat
  title: string
  author: string
  meta?: BookMeta
  /** 封面字节；不提供则无封面 */
  coverBytes?: Uint8Array
  coverExt?: string
}

export function createBookId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function extOf(path: string, fallback: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(path)
  return m?.[1]?.toLowerCase() ?? fallback
}

/** 把外部文件拷进书库并登记。返回新记录；重复导入返回已有记录。 */
export async function addBook(api: AppApi, input: AddBookInput): Promise<BookRecord> {
  const books = await loadBooks(api)

  // 判重放在拷贝之前：先拷再删的话，Windows 偶尔会短暂锁住刚建的文件，
  // 删不掉就留下一个谁也不认的孤儿副本。不拷就不必删。
  const sourceStat = await api.fs.stat(input.sourcePath)
  const size = sourceStat?.size ?? 0
  const dup = books.find((b) => b.size === size && b.title === input.title)
  if (dup) return dup

  const id = createBookId()
  const ext = extOf(input.sourcePath, input.format)
  const fileRel = `files/${id}.${ext}`
  const dest = await api.fs.resolveInShared('library', fileRel)
  await api.fs.copy(input.sourcePath, dest)

  let coverRel: string | null = null
  if (input.coverBytes && input.coverBytes.length > 0) {
    const cext = input.coverExt ?? 'jpg'
    coverRel = `covers/${id}.${cext}`
    const coverDest = await api.fs.resolveInShared('library', coverRel)
    await api.fs.write(coverDest, input.coverBytes)
  }

  const record: BookRecord = {
    id,
    title: input.title,
    author: input.author,
    format: input.format,
    file: fileRel,
    cover: coverRel,
    size,
    addedAt: new Date().toISOString(),
    progress: null,
    meta: input.meta ?? {}
  }

  await saveBooks(api, [record, ...books])
  return record
}

export async function removeBook(api: AppApi, id: string): Promise<void> {
  const books = await loadBooks(api)
  const target = books.find((b) => b.id === id)
  if (!target) return

  const next = books.filter((b) => b.id !== id)
  await saveBooks(api, next)

  const fileDest = await api.fs.resolveInShared('library', target.file)
  await api.fs.remove(fileDest).catch(() => undefined)
  if (target.cover) {
    const coverDest = await api.fs.resolveInShared('library', target.cover)
    // 地址缓存跟着文件一起作废，否则同名重建的那本会拿到一个指向已释放内容的地址
    const stale = coverCache.get(target.cover)
    if (stale) {
      coverCache.delete(target.cover)
      URL.revokeObjectURL(stale)
    }
    await api.fs.remove(coverDest).catch(() => undefined)
  }
}

export async function setProgress(
  api: AppApi,
  id: string,
  progress: BookProgress | null
): Promise<void> {
  const books = await loadBooks(api)
  const next = books.map((b) => (b.id === id ? { ...b, progress } : b))
  await saveBooks(api, next)
}
