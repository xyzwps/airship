import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Source } from './connection.ts'

/**
 * 后端进程里的全部网络活：与对象存储端点说话，也搬本地文件的字节。
 *
 * 这一族从前住在渲染进程（`client.ts` + `transfer.ts` + 那条 `net` 能力位），
 * 2026-11-24 整族搬到这里：窗口不再直连外部服务，SDK 的 fetch 换成后端进程的 HTTPS 模块，
 * CSP 与同源策略都不需要为它放宽——所以这份文件里没有一处 `fetch`。
 *
 * 业务全在可换的 io 上过：`backend.ts` 喂真文件系统，用例把同一份 `handle`
 * 接在替身的内存卷上跑（端点侧仍对真 HTTP 假端点说话，判据不变）。
 *
 * 两处是照着**真端点**调出来的，不是照文档写的，改之前先连一次 RustFS 看看：
 *
 *   - `forcePathStyle`：桶名在路径里，不在主机名里（自建端点普遍只认这种）；
 *   - 校验和两档：SDK 3.750 之后默认给 PutObject 带上 CRC32 校验和，
 *     并按响应里的校验和做校验——S3 兼容端点大多不认这套，请求会在服务端被拒成一句看不懂的 XML。
 *     `WHEN_REQUIRED` 才是"只在协议要求时才带"，也就是不带。
 *
 * 调用**无状态**：每一次都把连接（端点、密钥）随载荷带进来，后端自己不记。
 * 后端进程崩了再拉起，不需要"恢复会话"——这是它随窗口生死也不伤数据的底气。
 */

export interface BucketRow {
  name: string
  /** ISO 串；有的自建端点不返回创建时间，留空就不在界面上念 */
  createdAt: string
}

/** 对象列表里的一行：要么是"目录"（公共前缀），要么是一个对象 */
export interface ObjectRow {
  kind: 'prefix' | 'object'
  /** 目录行给的是前缀本身，对象行给的是键 */
  key: string
  /** 界面上念的那一段名字：去掉当前前缀后的头一段（目录行带尾斜杠） */
  label: string
  size: number
  lastModified: string
}

/** 一段对象，加上"还有下一段"那一点信息 */
export interface ObjectPage {
  rows: ObjectRow[]
  nextToken: string | null
}

export interface ObjectMeta {
  size: number
  contentType: string
  lastModified: string
}

/** 每段问端点几把键：固定 500，没有档位可选（判据 OS-059）。MaxKeys 数的是键，不是行 */
export const LIST_PAGE_KEYS = 500

/** 到这个数以上就分段（S3 的分段最小 5 MiB，最后一块除外） */
export const MULTIPART_FROM = 32 * 1024 * 1024
/** 分段大小 */
export const PART_SIZE = 8 * 1024 * 1024

/* ---------------- 盘上的事（可注入） ---------------- */

/** 后端要碰盘的那几件事——`backend.ts` 一份 node:fs 的，用例一份内存的 */
export interface BackendIo {
  /** 这个本机路径的字节数；不存在、读不出、不是文件——都回 null，不区分原因 */
  fileSize(path: string): Promise<number | null>
  /** 按区间读；读不出来抛（调用方换成"读不出来"那句人话） */
  readRange(path: string, start: number, length: number): Promise<Uint8Array>
  /** 下载的落点：边接边收，finish 定稿返回字节数，abort 连半份文件都不留 */
  sink(path: string): Sink
}

export interface Sink {
  append(chunk: Uint8Array): Promise<void>
  finish(): Promise<number>
  abort(): Promise<void>
}

/** 主动推给窗口的事件（backend:event 那一族），由 backend.ts / 用例注入 */
export type Emit = (method: string, payload?: unknown) => void

/* ---------------- 客户端 ---------------- */

/**
 * 连接 → 客户端的小账本。
 *
 * 每次调用都新建 S3Client 会把 TLS 握手白付一遍；按连接字段全量拼键，
 * 改了任何一项自然换一份，不需要谁通知谁。
 */
const clients = new Map<string, S3Client>()

export function clientFor(conn: Source): S3Client {
  const k = `${conn.endpoint}|${conn.region}|${conn.accessKeyId}|${conn.secretAccessKey}`
  const hit = clients.get(k)
  if (hit) return hit
  const created = new S3Client({
    region: conn.region,
    endpoint: conn.endpoint,
    credentials: { accessKeyId: conn.accessKeyId, secretAccessKey: conn.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
  clients.set(k, created)
  return created
}

/* ---------------- 短调用 ---------------- */

export async function listBuckets(conn: Source): Promise<BucketRow[]> {
  const out = await clientFor(conn).send(new ListBucketsCommand({}))
  return (out.Buckets ?? []).map((b) => ({
    name: b.Name ?? '',
    createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : ''
  }))
}

/**
 * 列一层里的一段：分隔符固定 `/`，所以键里的斜杠在界面上就是目录。
 *
 * 一次问 500 把键，端点回多少行就显示多少行（照单全收，判据 OS-059~061）：
 * `MaxKeys` 数的是**键**不是**行**，一层全是目录时几把键聚合成一行，
 * 一次回话的行数可以远少于 500（2026-11-20 RustFS 实拍：50 档只回 25 行目录）。
 * 从前这里按行拼页、凑满档位才罢休（OS-058 一族），2026-11-21 退场：
 * 拼页在一个大目录面前要烧掉上百条串问，而各家端点对"一个目录算几把键"的账还不一样
 * （AWS 的文档说 roll-up 按一条计，RustFS 按底层键计），应用侧拼不起端点的账。
 *
 * 往后翻是端点原生支持的 `NextContinuationToken`（只有往后的，没有往前的——
 * 上一页靠应用记住沿途的 token，判据见册子 OS-054）。
 */
export async function listObjects(conn: Source, bucket: string, prefix: string, token: string | undefined): Promise<ObjectPage> {
  const out = await clientFor(conn).send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix === '' ? undefined : prefix,
      Delimiter: '/',
      MaxKeys: LIST_PAGE_KEYS,
      ContinuationToken: token
    })
  )
  const rows: ObjectRow[] = []
  for (const p of out.CommonPrefixes ?? []) {
    const key = p.Prefix ?? ''
    rows.push({ kind: 'prefix', key, label: labelOf(key, prefix), size: 0, lastModified: '' })
  }
  for (const o of out.Contents ?? []) {
    const key = o.Key ?? ''
    // 前缀本身也会作为一条对象回来（"目录"这一格是自己存出来的空键），列出来只是噪音
    if (key === prefix) continue
    rows.push({
      kind: 'object',
      key,
      label: labelOf(key, prefix),
      size: o.Size ?? 0,
      lastModified: o.LastModified ? new Date(o.LastModified).toISOString() : ''
    })
  }
  return { rows, nextToken: out.IsTruncated ? (out.NextContinuationToken ?? null) : null }
}

/** 列表头一段的名字：公共前缀留着尾斜杠，一眼分得出它是"目录" */
function labelOf(key: string, prefix: string): string {
  const rest = key.startsWith(prefix) ? key.slice(prefix.length) : key
  if (rest.includes('/')) {
    const head = rest.slice(0, rest.indexOf('/') + 1)
    return head
  }
  return rest
}

export async function headObject(conn: Source, bucket: string, key: string): Promise<ObjectMeta> {
  const out = await clientFor(conn).send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    size: out.ContentLength ?? 0,
    contentType: out.ContentType ?? '',
    lastModified: out.LastModified ? new Date(out.LastModified).toISOString() : ''
  }
}

/**
 * 取回整个对象的字节——只有预览用，上限由界面那侧判（OS-019：超过 8 MB 只问 HEAD 不接字节）。
 * 下载不从这里走：那是一条边接边写的路（downloadJob），没有内存上限。
 */
export async function getObjectBytes(conn: Source, bucket: string, key: string): Promise<Uint8Array> {
  const out = await clientFor(conn).send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!out.Body) return new Uint8Array()
  return new Uint8Array(await out.Body.transformToByteArray())
}

/**
 * 目录标记：一个以 `/` 结尾的零字节对象。
 *
 * 端点本来没有目录，`logs/` 这一行之所以看得见，是因为里面有对象被分隔符卷到了一起。
 * 空目录要能存在，就得多存这一个键——各家控制台建"文件夹"存的都是它。
 */
export async function putDirMarker(conn: Source, bucket: string, key: string): Promise<void> {
  await clientFor(conn).send(new PutObjectCommand({ Bucket: bucket, Key: key }))
}

/**
 * 端点上有没有这个目录标记（`logs/` 那樣的键）。
 *
 * 只有 404 才算"没有标记"——那是从里面的对象读出来的合成目录。
 * 403 与连不上一句都不能吞：吞了就把"密钥被拒"念成"没有单独的标记可删"。
 */
export async function dirMarkerExists(conn: Source, bucket: string, key: string): Promise<boolean> {
  try {
    await clientFor(conn).send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return true
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
    throw e
  }
}

/**
 * 服务端把对象复制成一个新键——重命名用的就是它。
 *
 * S3 没有"重命名"这个操作；`CopyObject` + 删源是所有兼容端点都实现的组合，
 * AWS 自家控制台念的"rename"也是这条。上限是**服务端一次复制 5 GB**——
 * 更大的对象要做就得走分段复制那一整套，界面上不接这活，当场把两个数念出来（判据 OS-049）。
 */
export async function copyObject(conn: Source, bucket: string, sourceKey: string, destKey: string): Promise<void> {
  await clientFor(conn).send(
    new CopyObjectCommand({
      Bucket: bucket,
      CopySource: encodeCopySource(`${bucket}/${sourceKey}`),
      Key: destKey
    })
  )
}

/** 桶段照原样，键按段转义：中文与空格的键在头里必须是百分号形式 */
function encodeCopySource(source: string): string {
  return source.split('/').map(encodeURIComponent).join('/')
}

export async function deleteObject(conn: Source, bucket: string, key: string): Promise<void> {
  await clientFor(conn).send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function createBucket(conn: Source, bucket: string): Promise<void> {
  await clientFor(conn).send(new CreateBucketCommand({ Bucket: bucket }))
}

/**
 * 一条有时效的读链接。
 *
 * 有效期是"这链接给别人能用多久"，界面上只给一档默认一小时；签好名的地址本身不含密钥，
 * 拿到它的人在那一段时间里就能读这个对象——所以它是"临时"的，值得界面上把秒数念出来。
 */
export async function presignGet(conn: Source, bucket: string, key: string, seconds = 3600): Promise<string> {
  return getSignedUrl(clientFor(conn), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds })
}

/* ---------------- 长任务：上传与下载 ---------------- */

export interface UploadPayload {
  conn: Source
  bucket: string
  key: string
  /** 本机路径：按钮选来的与拖进来的在这一步之后同形 */
  path: string
  /** 界面上那一行认它 */
  name: string
  contentType: string
  /** 来路是拖进来的：读不出来时念那句专门的话（判据 OS-045） */
  dropped?: boolean
  job: string
}

export interface DownloadPayload {
  conn: Source
  bucket: string
  key: string
  destPath: string
  name: string
  job: string
}

/**
 * 先判盘、后交任务：本地文件读不出来就在**这次调用**上抛（界面上直接见那句人话），
 * 不是先回"收下了"再在事件里补一句失败。判过了才回执、才异步搬字节。
 */
export async function startUpload(conn: Source, io: BackendIo, p: UploadPayload, emit: Emit): Promise<true> {
  const size = await io.fileSize(p.path)
  if (size === null) throw new Error(p.dropped ? '拖进来的那一样读不出来，没上传' : '读不到这个文件')
  void runUpload(conn, io, p, size, emit)
  return true
}

/** 上传一份本地文件；进度与结局全部走事件，invoke 那句回执早就发出去了 */
async function runUpload(conn: Source, io: BackendIo, p: UploadPayload, size: number, emit: Emit): Promise<void> {
  const { job, name, bucket, key, contentType } = p
  const client = clientFor(conn)
  try {
    if (size < MULTIPART_FROM) {
      emit('upload:part', { job, name, done: 1, total: 1 })
      const bytes = await io.readRange(p.path, 0, size)
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }))
    } else {
      const total = Math.ceil(size / PART_SIZE)
      const created = await client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
      )
      const uploadId = created.UploadId ?? ''
      const parts: { PartNumber: number; ETag?: string }[] = []
      try {
        for (let i = 0; i < total; i += 1) {
          const start = i * PART_SIZE
          const bytes = await io.readRange(p.path, start, Math.min(PART_SIZE, size - start))
          const out = await client.send(
            new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: i + 1, Body: bytes })
          )
          parts.push({ PartNumber: i + 1, ETag: out.ETag })
          emit('upload:part', { job, name, done: i + 1, total })
        }
        await client.send(
          new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } })
        )
      } catch (err) {
        // 半途而废要先把那笔分段上传撤掉，不然端点上留一堆没人收的碎片（占着流量与存储）
        try {
          await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
        } catch {
          /* 撤不掉也不能把原来的错盖住 */
        }
        throw err
      }
    }
    emit('upload:done', { job, name, bytes: size })
  } catch (e) {
    emit('upload:error', { job, name, message: errorText(e) })
  }
}

/**
 * 下载一个对象到本机路径：边接边写，没有内存上限。
 *
 * 从前这里"一次接一整份"，所以钉了 256 MB 的拒收线（已删除的 OS-015，注记在册子里）；
 * 搬进后端进程后 body 是流，写盘不再需要先装下整个对象。
 * 半途断线要把那半份文件删干净——留一个"看着下载完了其实缺一块"的文件比报错更坏（OS-063）。
 */
export async function startDownload(conn: Source, io: BackendIo, p: DownloadPayload, emit: Emit): Promise<true> {
  void runDownload(conn, io, p, emit)
  return true
}

async function runDownload(conn: Source, io: BackendIo, p: DownloadPayload, emit: Emit): Promise<void> {
  const { job, bucket, key, destPath } = p
  const sink = io.sink(destPath)
  try {
    const out = await clientFor(conn).send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    for await (const chunk of bodyChunks(out.Body)) await sink.append(chunk)
    const bytes = await sink.finish()
    emit('download:done', { job, name: p.name, bytes })
  } catch (e) {
    await sink.abort().catch(() => undefined)
    emit('download:error', { job, name: p.name, message: errorText(e) })
  }
}

/**
 * 端点回的对象体拆成一块块字节。
 *
 * Node 侧这份 body 在 SDK 各版本里转过形（node:Readable → web ReadableStream），
 * 两代都能 `for await`；万一撞上只有整份接口的实现，退回一次性读完——
 * 那种退回只可能出现在没见过的 SDK 形状上，与其悄悄丢数据不如照常办成。
 */
async function* bodyChunks(body: unknown): AsyncGenerator<Uint8Array> {
  if (!body) return
  const it = body as AsyncIterable<Uint8Array | string> | { transformToByteArray(): Promise<Uint8Array> }
  if (Symbol.asyncIterator in Object(it)) {
    for await (const chunk of it as AsyncIterable<Uint8Array | string>) {
      yield typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    }
    return
  }
  const whole = body as { transformToByteArray(): Promise<Uint8Array> }
  yield await whole.transformToByteArray()
}

/* ---------------- 方法表 ---------------- */

const handlers: Record<string, (payload: any, io: BackendIo, emit: Emit) => unknown | Promise<unknown>> = {
  listBuckets: (p) => listBuckets(p.conn),
  listObjects: (p) => listObjects(p.conn, p.bucket, p.prefix, p.token),
  head: (p) => headObject(p.conn, p.bucket, p.key),
  getBytes: (p) => getObjectBytes(p.conn, p.bucket, p.key),
  putDirMarker: async (p) => (await putDirMarker(p.conn, p.bucket, p.key), true),
  dirMarkerExists: (p) => dirMarkerExists(p.conn, p.bucket, p.key),
  copyObject: async (p) => (await copyObject(p.conn, p.bucket, p.sourceKey, p.destKey), true),
  deleteObject: async (p) => (await deleteObject(p.conn, p.bucket, p.key), true),
  createBucket: async (p) => (await createBucket(p.conn, p.bucket), true),
  presignGet: (p) => presignGet(p.conn, p.bucket, p.key),
  upload: (p, io, emit) => startUpload(p.conn, io, p, emit),
  download: (p, io, emit) => startDownload(p.conn, io, p, emit)
}

/**
 * 一次调用的落点。抛出去的原因就是要念给用户听的那句人话——
 * SDK 的对象、堆栈都不许原样出这道门（`backend.ts` 把 message 装进回话）。
 */
export async function handle(method: string, payload: unknown, io: BackendIo, emit: Emit): Promise<unknown> {
  const fn = handlers[method]
  if (!fn) throw new Error(`后端不认的方法：${method}`)
  try {
    return await fn(payload ?? {}, io, emit)
  } catch (e) {
    throw new Error(e instanceof Error ? errorText(e) : String(e))
  }
}

/**
 * SDK 抛回来的错是 JS 对象（`$metadata`、`Code` 这些），界面要念的是一句话。
 * 端点连不上与密钥不对是两种完全不同的下一步，所以这里把它们分开说。
 * 措辞一字没改地搬了过来——它们仍是用户看得见的那句中文（册子 OS-003 一族）。
 */
export function errorText(error: unknown): string {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number }; Code?: string }
  const name = e?.name ?? ''
  const code = e?.Code ?? ''
  const status = e?.$metadata?.httpStatusCode ?? 0

  if (name === 'NoSuchBucket' || code === 'NoSuchBucket') return '这个桶不存在'
  if (status === 403 || name === 'AccessDenied' || code === 'AccessDenied') return '端点拒绝了这个密钥（403）'
  if (status === 404) return '端点上找不到这个东西（404）'
  // 端口写错、服务没起、地址拼不上、下到一半断了——这几类在 Node 里各有各的话，都归到"连不上"
  // （`premature close` 与 `aborted` 都是流半路没货时 Node 的原话——OS-063 实测断线念的是 `aborted`）
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|premature close|aborted|network|ERR_/i.test(`${name} ${e?.message ?? ''}`)) {
    return `连不上端点（${e?.message ?? name}）`
  }
  if (name === 'SignatureDoesNotMatch' || code === 'SignatureDoesNotMatch') {
    return '签名对不上：Secret Key 或区域填错了'
  }
  const message = (e?.message ?? '').trim()
  return message === '' ? '端点返回了没认出来的错误' : message
}
