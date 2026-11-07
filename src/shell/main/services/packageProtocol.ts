import { protocol } from 'electron'
import { basename, extname } from 'node:path'
import { packageFor } from './appRegistry'
import { normalizeEntryName } from './packageArchive'
import { readArchiveEntry } from './packageArchive'
import { entryOf } from '@airship/contract'
import { notRegistered } from '@airship/contract'

/**
 * `airship://<id>/<包内相对路径>` —— 把一个归档里的条目当文档根下的文件供出去。
 *
 * 一个包就是一个 zip 归档 `<id>.airship`，所以这里没有"目录"可指：
 * 请求解成（哪个归档，哪个条目），条目字节由 `packageArchive.ts` 单独解出来。
 *
 * 为什么用自定义协议而不是 `file://` 指解包目录：那条路要么把整个 userData 暴露给渲染进程，
 * 要么每个窗口换一条 CSP 白名单；协议这一条把可达范围钉死在**这一个包**里。
 *
 * 三条硬规矩：
 *   1. 只认已注册的 id——查不到包就是 `notRegistered` 那句原话（与窗口侧同一份措辞）。
 *   2. 条目名必须是包内相对路径：`..`、绝对路径、反斜杠一律拒（PK-014）。
 *   3. 只读，不接受任何写请求。
 *
 * 方案属性必须在 `app.whenReady()` 之前注册（Electron 的硬性时序），
 * 所以这里拆成两个函数，由 `main/index.ts` 在两个时点各调一次。
 */

export const AIRSHIP_SCHEME = 'airship'

/** 当"文本"发的类型；其余按扩展名补，认不出的一律 octet-stream */
const TEXT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
}

/** 注册方案属性——必须在 app ready 之前 */
export function registerAirshipScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: AIRSHIP_SCHEME,
      privileges: {
        // standard：URL 有 host 段，`airship://life/index.html` 的 origin 才算得出来，
        // 包里的相对引用与 CSP 的 'self' 才有意义
        standard: true,
        // secure：这个 origin 算安全上下文，crypto.subtle 与 blob worker 这类 API 才肯放行
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

/**
 * 把一个 `airship://<id>/<相对路径>` 解成（哪个归档，哪个条目），或者给出拒绝的原话。
 *
 * 单独拆出来是为了这条判据能测（PK-014）：这一步不需要 Electron，
 * 而"越界与没装进来各有各的原话"正是它的契约。
 * `lookup` 就是"id → 包"的查法，产品里用注册表，用例里给一张表。
 */
export function resolvePackageEntry(
  requestUrl: string,
  lookup: (id: string) => { archive: string; entry: string } | null
): { archive: string; name: string } | { reason: string } {
  const url = new URL(requestUrl)
  const id = decodeURIComponent(url.hostname)
  const pkg = lookup(id)
  if (!pkg) return { reason: notRegistered(id) }

  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  const name = normalizeEntryName(rel === '' ? pkg.entry : rel)
  if (name === null) {
    return { reason: `请求的条目不在包里：${rel || pkg.entry}（${id} 的归档只认包内相对路径）` }
  }
  return { archive: pkg.archive, name }
}

/** 挂处理器——在 app ready 之后调 */
export function serveAirshipPackages(): void {
  protocol.handle(AIRSHIP_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(`${AIRSHIP_SCHEME}: 只读，不接受 ${request.method}`, { status: 405 })
    }

    const resolved = resolvePackageEntry(request.url, (id) => {
      const pkg = packageFor(id)
      return pkg ? { archive: pkg.archive, entry: entryOf(pkg.manifest) } : null
    })
    if ('reason' in resolved) return fail(404, resolved.reason)

    const body = readArchiveEntry(resolved.archive, resolved.name)
    if (body === null) {
      return fail(404, `这个包里没有：${resolved.name}（${basename(resolved.archive)}）`)
    }
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: {
        'content-type': contentTypeOf(resolved.name),
        'content-length': String(body.byteLength),
        // 装包是整档替换，归档的 mtime 就是版本；不给缓存机会，改了包立刻生效
        'cache-control': 'no-store'
      }
    })
  })
}

function contentTypeOf(name: string): string {
  const ext = extname(basename(name)).toLowerCase()
  return TEXT_TYPES[ext] ?? 'application/octet-stream'
}

function fail(status: number, reason: string): Response {
  return new Response(reason, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}
