import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 一个只在内存里的假 S3 端点，给应用侧用例当"网络那一边"。
 *
 * 为什么是真起一个 HTTP 服务而不是换掉 `fetch`：SDK 在测试里挑的是 Node 那一档传输
 * （`NodeHttpHandler`），换 `fetch` 换不到它——请求照样发到机器上真的端点去，
 * 界面念出来的 403 来自真服务，用例却看起来像替身的错。起一个真服务，
 * 签名、分块、XML 解析这一整条链就是原样跑过的。
 *
 * 它按 S3 的**线格式**回话，不是按我们的想象：
 *   - 路径风格 `/bucket/key`，查询串里 `list-type=2`、`uploads`、`partNumber`、`uploadId`；
 *   - 列表用 `CommonPrefixes` 表达"目录"（那是分隔符查询的结果，端点本来没有目录）；
 *   - 出错回一段 `<Error><Code>…` 的 XML 加一个 4xx 状态码。
 *
 * 浏览器里那条传输（出包后的窗口用的那一条）不在这里验——那是 `just shot` 连真 RustFS 的事。
 */

/** 文本或字节：用例喂进来的东西 */
export type Content = string | Uint8Array

export interface Stored {
  bytes: Uint8Array
  type: string
  /** 毫秒；界面上要念得出改动时间 */
  mtime: number
  /**
   * 报给外面的字节数，与实际存着的字节无关。
   * 用例要演"300 MB 的对象"不能真去分配 300 MB——大小是端点报的，判据跟着报的走。
   */
  sizeHint?: number
}

export interface SeedObject {
  body: Content
  type?: string
  mtime?: number
  sizeHint?: number
}

interface Reply {
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

let uploadSeq = 0

export class FakeS3 {
  /** 桶 → 键 → 内容 */
  readonly buckets = new Map<string, Map<string, Stored>>()
  /** 收到过的请求，用例按它断言"发没发出去""分了几段" */
  readonly requests: Array<{ method: string; path: string; query: string }> = []
  /** 置真就一律回 403，用来演密钥被拒 */
  denyAll = false
  /** 置真就一律回 404，用来演"端点上没有" */
  missingAll = false

  private readonly uploads = new Map<string, { bucket: string; key: string; parts: Map<number, Uint8Array>; type: string }>()
  private server: Server | null = null

  constructor(seed: Record<string, Record<string, SeedObject>> = {}) {
    for (const [bucket, objects] of Object.entries(seed)) {
      const dir = this.buckets.set(bucket, new Map<string, Stored>()).get(bucket)!
      for (const [key, o] of Object.entries(objects)) {
        dir.set(key, {
          bytes: toBytes(o.body),
          type: o.type ?? '',
          mtime: o.mtime ?? Date.parse('2026-11-08T10:00:00.000Z'),
          ...(o.sizeHint === undefined ? {} : { sizeHint: o.sizeHint })
        })
      }
    }
  }

  /** 起服务，返回可以直接填进"端点"那一格的地址 */
  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.route(req, res)
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    const port = (this.server.address() as AddressInfo).port
    return `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = null
    // 应用侧的 SDK 用长连接，不把所有连接掐掉 close 会一直挂着
    ;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  /** 端点上那个对象现在是什么（用例用它断言"传上去的字节与本地一致"） */
  object(bucket: string, key: string): Stored | undefined {
    return this.buckets.get(bucket)?.get(key)
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const method = (req.method ?? 'GET').toUpperCase()
    const path = decodeURIComponent(url.pathname)
    const body = await readRequest(req)
    this.requests.push({ method, path, query: url.search })

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[name.toLowerCase()] = value
    }
    const reply = this.dispatch(method, path, url.searchParams, body, headers)
    res.writeHead(reply.status, reply.headers)
    res.end(reply.body === null ? undefined : Buffer.from(reply.body))
  }

  private dispatch(method: string, path: string, query: URLSearchParams, body: Uint8Array, headers: Record<string, string>): Reply {
    if (this.denyAll) return xml(403, '<Error><Code>AccessDenied</Code><Message>nope</Message></Error>')
    if (this.missingAll) return xml(404, '<Error><Code>NoSuchKey</Code><Message>no</Message></Error>')

    const seg = path.replace(/^\/+/, '').split('/')
    const bucket = seg[0] ?? ''
    const key = seg.slice(1).join('/')

    if (path === '/' && method === 'GET') return this.listBuckets()
    if (key === '' && method === 'GET') return this.listObjects(bucket, query)
    if (key === '' && method === 'PUT') return this.createBucket(bucket)

    if (method === 'POST' && query.has('uploads')) return this.startUpload(bucket, key, headers)
    if (method === 'POST' && query.has('uploadId')) return this.completeUpload(query, body)
    if (method === 'PUT' && query.has('uploadId')) return this.uploadPart(query, body)
    if (method === 'DELETE' && query.has('uploadId')) {
      this.uploads.delete(query.get('uploadId') ?? '')
      return { status: 204, headers: {}, body: null }
    }

    if (method === 'HEAD') return this.head(bucket, key)
    if (method === 'GET') return this.getObject(bucket, key)
    if (method === 'PUT') return this.putObject(bucket, key, body, headers)
    if (method === 'DELETE') return this.deleteObject(bucket, key)

    return xml(501, '<Error><Code>NotImplemented</Code><Message>假端点没实现这一条</Message></Error>')
  }

  private listBuckets(): Reply {
    const rows = [...this.buckets.keys()]
      .sort()
      .map((n) => `<Bucket><Name>${esc(n)}</Name><CreationDate>2026-11-08T09:00:00.000Z</CreationDate></Bucket>`)
      .join('')
    return xml(200, `<ListAllMyBucketsResult><Buckets>${rows}</Buckets></ListAllMyBucketsResult>`)
  }

  /**
   * 按分隔符列一层：真端点怎么分组，这里就怎么分组。
   * `max-keys` 与 `continuation-token` 都认，分页那条判据要靠它。
   */
  private listObjects(bucket: string, query: URLSearchParams): Reply {
    const dir = this.buckets.get(bucket)
    if (!dir) return xml(404, '<Error><Code>NoSuchBucket</Code><Message>没有这个桶</Message></Error>')
    const prefix = query.get('prefix') ?? ''
    const delimiter = query.get('delimiter') ?? ''
    const max = Number(query.get('max-keys') ?? '1000')
    const from = Number(query.get('continuation-token') ?? '0')

    const entries: Array<{ key: string; obj: Stored }> = []
    const prefixes = new Set<string>()
    for (const [key, obj] of [...dir].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      if (delimiter !== '' && rest.includes(delimiter)) {
        prefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + delimiter.length))
        continue
      }
      entries.push({ key, obj })
    }

    const merged: Array<{ kind: 'prefix'; key: string } | { kind: 'object'; key: string; obj: Stored }> = [
      ...[...prefixes].sort().map((p) => ({ kind: 'prefix' as const, key: p })),
      ...entries.map((e) => ({ kind: 'object' as const, ...e }))
    ]
    const page = merged.slice(from, from + max)
    const truncated = from + max < merged.length

    const body = [
      `<ListBucketResult><Name>${esc(bucket)}</Name><Prefix>${esc(prefix)}</Prefix>`,
      `<KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys>`,
      delimiter !== '' ? `<Delimiter>${esc(delimiter)}</Delimiter>` : '',
      `<IsTruncated>${truncated}</IsTruncated>`,
      truncated ? `<NextContinuationToken>${from + max}</NextContinuationToken>` : '',
      ...page.map((row) =>
        row.kind === 'prefix'
          ? `<CommonPrefixes><Prefix>${esc(row.key)}</Prefix></CommonPrefixes>`
          : `<Contents><Key>${esc(row.key)}</Key><LastModified>${new Date(row.obj.mtime).toISOString()}` +
            `</LastModified><ETag>&quot;x&quot;</ETag><Size>${sizeOf(row.obj)}</Size>` +
            `<StorageClass>STANDARD</StorageClass></Contents>`
      ),
      '</ListBucketResult>'
    ].join('')
    return xml(200, body)
  }

  private createBucket(bucket: string): Reply {
    if (this.buckets.has(bucket)) {
      return xml(409, '<Error><Code>BucketAlreadyOwnedByYou</Code><Message>已经有了</Message></Error>')
    }
    this.buckets.set(bucket, new Map<string, Stored>())
    return { status: 200, headers: { location: `/${bucket}` }, body: null }
  }

  private head(bucket: string, key: string): Reply {
    const found = this.buckets.get(bucket)?.get(key)
    if (!found) return xml(404, '<Error><Code>NoSuchKey</Code><Message>没有这个对象</Message></Error>')
    return {
      status: 200,
      headers: {
        'content-length': String(sizeOf(found)),
        'last-modified': new Date(found.mtime).toUTCString(),
        ...(found.type === '' ? {} : { 'content-type': found.type })
      },
      body: null
    }
  }

  private getObject(bucket: string, key: string): Reply {
    const found = this.buckets.get(bucket)?.get(key)
    if (!found) return xml(404, '<Error><Code>NoSuchKey</Code><Message>没有这个对象</Message></Error>')
    return {
      status: 200,
      headers: {
        'content-length': String(found.bytes.byteLength),
        'last-modified': new Date(found.mtime).toUTCString(),
        ...(found.type === '' ? {} : { 'content-type': found.type })
      },
      body: found.bytes
    }
  }

  private putObject(bucket: string, key: string, body: Uint8Array, headers: Record<string, string>): Reply {
    const dir = this.buckets.get(bucket)
    if (!dir) return xml(404, '<Error><Code>NoSuchBucket</Code><Message>没有这个桶</Message></Error>')
    dir.set(key, { bytes: body, type: headers['content-type'] ?? '', mtime: Date.parse('2026-11-08T10:00:00.000Z') })
    return { status: 200, headers: { etag: '"one"' }, body: null }
  }

  private deleteObject(bucket: string, key: string): Reply {
    this.buckets.get(bucket)?.delete(key)
    return { status: 204, headers: {}, body: null }
  }

  private startUpload(bucket: string, key: string, headers: Record<string, string>): Reply {
    uploadSeq += 1
    const id = `up-${uploadSeq}`
    this.uploads.set(id, { bucket, key, parts: new Map(), type: headers['content-type'] ?? '' })
    return xml(
      200,
      `<InitiateMultipartUploadResult><Bucket>${esc(bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`
    )
  }

  private uploadPart(query: URLSearchParams, body: Uint8Array): Reply {
    const upload = this.uploads.get(query.get('uploadId') ?? '')
    if (!upload) return xml(404, '<Error><Code>NoSuchUpload</Code><Message>分段上传不存在</Message></Error>')
    upload.parts.set(Number(query.get('partNumber')), body)
    return { status: 200, headers: { etag: `"p${query.get('partNumber')}"` }, body: null }
  }

  /** 收尾：按 XML 里那份段号清单拼回去，段序不对就该在这里炸出来 */
  private completeUpload(query: URLSearchParams, body: Uint8Array): Reply {
    const upload = this.uploads.get(query.get('uploadId') ?? '')
    if (!upload) return xml(404, '<Error><Code>NoSuchUpload</Code><Message>分段上传不存在</Message></Error>')
    const text = new TextDecoder().decode(body)
    const numbers = [...text.matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((m) => Number(m[1]))
    const chunks = numbers.map((n) => upload.parts.get(n) ?? new Uint8Array())
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const merged = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      merged.set(c, at)
      at += c.byteLength
    }
    this.buckets.get(upload.bucket)?.set(upload.key, { bytes: merged, type: upload.type, mtime: Date.parse('2026-11-08T10:00:00.000Z') })
    this.uploads.delete(query.get('uploadId') ?? '')
    return xml(
      200,
      `<CompleteMultipartUploadResult><Bucket>${esc(upload.bucket)}</Bucket><Key>${esc(upload.key)}</Key><ETag>&quot;all&quot;</ETag></CompleteMultipartUploadResult>`
    )
  }
}

function xml(status: number, body: string): Reply {
  return { status, headers: { 'content-type': 'application/xml' }, body: new TextEncoder().encode(body) }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 报出去的大小：有 sizeHint 就用它，否则用真实字节数 */
function sizeOf(stored: Stored): number {
  return stored.sizeHint ?? stored.bytes.byteLength
}

export function toBytes(content: Content): Uint8Array {
  if (typeof content === 'string') return new TextEncoder().encode(content)
  return content
}

async function readRequest(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  for await (const part of req) chunks.push(part as Buffer)
  return new Uint8Array(Buffer.concat(chunks))
}
