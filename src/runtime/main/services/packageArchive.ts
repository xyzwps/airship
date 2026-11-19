import { readFileSync, statSync } from 'node:fs'
import { strFromU8, unzipSync } from 'fflate'

/**
 * 读一个 airship 包（zip 归档）。
 *
 * 两条刻意的做法：
 *
 *   1. **只解要用的那一个条目**。fflate 的 `unzipSync(data, { filter })` 会先过一遍中央目录，
 *      filter 返回 false 的条目不解压——所以列条目名与取一个文件都不需要把整包展开。
 *      （这条 API 是读了 node_modules/fflate 的类型定义确认的，不是凭记忆：
 *      `UnzipOptions.filter?: UnzipFileFilter`，注释写的是 "extract only certain files"。）
 *   2. **按 mtime + 字节数判缓存是否作废**。装包是整档替换，改名会换 mtime；
 *      不做增量失效，因为"包被就地改了几个字节"这种局面我们不支持——重装就是换文件。
 *
 * 条目名一律是包内的相对路径（正斜杠）。越界的写法（`..`、绝对路径、反斜杠）一律当不存在，
 * 不做"抹掉前缀再试一次"那种回落：那会把一条本该拒绝的请求变成一次意外命中。
 */

const cache = new Map<string, { mark: string; names: string[] }>()

function stamp(archive: string): string {
  const st = statSync(archive)
  return `${st.mtimeMs}:${st.size}`
}

function bytes(archive: string): Uint8Array {
  return new Uint8Array(readFileSync(archive))
}

/** 归档里的条目名（不解压任何内容）；读不出来就抛，让调用方把原因写进问题清单 */
export function archiveEntryNames(archive: string): string[] {
  const mark = stamp(archive)
  const hit = cache.get(archive)
  if (hit && hit.mark === mark) return hit.names

  const names: string[] = []
  // filter 里只收集名字、一律返回 false：一个字节都不解压
  unzipSync(bytes(archive), {
    filter: (file) => {
      names.push(file.name)
      return false
    }
  })
  cache.set(archive, { mark, names })
  return names
}

/**
 * 取一个条目的字节。不存在返回 null（调用方负责念出"包里没有这个文件"那一句）。
 *
 * 命中缓存名字表后仍要过一遍解压——filter 只挑出那一条，代价是一个文件而不是整包。
 */
export function readArchiveEntry(archive: string, name: string): Uint8Array | null {
  const safe = normalizeEntryName(name)
  if (safe === null) return null
  const names = archiveEntryNames(archive)
  if (!names.includes(safe)) return null
  const out = unzipSync(bytes(archive), { filter: (file) => file.name === safe })
  return out[safe] ?? null
}

/** 取一个文本条目（清单与 html 用） */
export function readArchiveText(archive: string, name: string): string | null {
  const raw = readArchiveEntry(archive, name)
  return raw === null ? null : strFromU8(raw)
}

/**
 * 条目名的规范化：只接受包内相对路径。
 * 越界、绝对、带反斜杠的一律 null（调用方给拒绝的原话）。
 */
export function normalizeEntryName(input: string): string | null {
  const trimmed = input.replace(/^\/+/, '')
  if (trimmed === '' || trimmed.includes('\\')) return null
  const segments = trimmed.split('/')
  if (segments.some((s) => s === '..' || s === '')) return null
  return segments.join('/')
}

/** 归档变了（重装或删除）就把它的缓存丢掉 */
export function forgetArchive(archive: string): void {
  cache.delete(archive)
}
