import type { AppApi } from '../shell/useAppApi'

/**
 * 壳级共享书库。
 *
 * 落在 shared/library/ 下，books（EPUB/MOBI/TXT）和 pdf 两个应用共用：
 *   library.json        书目索引
 *   files/<id><ext>     书的本体（导入时拷进来，不依赖用户原路径还活着）
 *   covers/<id>.<ext>   封面图
 *
 * 书库只负责"存"和"索引"。元数据和封面由导入方提供：
 * books 用 foliate-js 的 makeBook 读 EPUB/MOBI 的 metadata 与封面，
 * pdf 用 pdfjs-dist 数页数、渲染第一页当封面。
 * 这样书库不绑任何渲染库，两个应用谁先导入都行。
 */

export type BookFormat = 'epub' | 'mobi' | 'txt' | 'pdf'

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
  /** pdf 页数；其他格式为 0 */
  pages: number
}

interface LibraryFile {
  version: 1
  books: BookRecord[]
}

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
  return parsed.books.filter((b): b is BookRecord => Boolean(b && typeof b.id === 'string'))
}

export function saveBooks(api: AppApi, books: BookRecord[]): Promise<void> {
  const pending = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const path = await indexPath(api)
      const file: LibraryFile = { version: 1, books }
      await api.fs.write(path, `${JSON.stringify(file, null, 2)}\n`)
    })
  writeQueue = pending.catch(() => undefined)
  return pending
}

export function bookPath(api: AppApi, book: BookRecord): Promise<string> {
  return api.fs.resolveInShared('library', book.file)
}

/** 封面转成能直接给 <img> 用的 file:// URL */
export async function coverUrl(api: AppApi, book: BookRecord): Promise<string | null> {
  if (!book.cover) return null
  const path = await api.fs.resolveInShared('library', book.cover)
  const normalized = path.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}

export interface AddBookInput {
  sourcePath: string
  format: BookFormat
  title: string
  author: string
  pages?: number
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

/** 把外部文件拷进书库并登记。返回新记录。 */
export async function addBook(api: AppApi, input: AddBookInput): Promise<BookRecord> {
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

  const stat = await api.fs.stat(dest)

  const record: BookRecord = {
    id,
    title: input.title,
    author: input.author,
    format: input.format,
    file: fileRel,
    cover: coverRel,
    size: stat?.size ?? 0,
    addedAt: new Date().toISOString(),
    progress: null,
    pages: input.pages ?? 0
  }

  const books = await loadBooks(api)
  // 同一本书重复导入：按大小+文件名去重，直接返回已有记录
  const dup = books.find((b) => b.size === record.size && b.title === record.title)
  if (dup) {
    await api.fs.remove(dest).catch(() => undefined)
    if (coverRel) {
      const cd = await api.fs.resolveInShared('library', coverRel)
      await api.fs.remove(cd).catch(() => undefined)
    }
    return dup
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
