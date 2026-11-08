import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Source } from './connection.ts'

/**
 * 与对象存储端点说话的那一层。
 *
 * SDK 只做两件事：把命令拼成签名好的 HTTP 请求、把响应 XML 解成这里的行形状。
 * 传输走渲染进程自己的 `fetch`——这就是清单里那条 `net` 能力的全部含义
 * （判据见 `src/shell/specs/bridge.md` BR-011）。
 *
 * 两处是照着**真端点**调出来的，不是照文档写的，改之前先连一次 RustFS 看看：
 *
 *   - `forcePathStyle`：桶名在路径里，不在主机名里（自建端点普遍只认这种）；
 *   - 校验和两档：SDK 3.750 之后默认给 PutObject 带上 CRC32 校验和，
 *     并按响应里的校验和做校验——S3 兼容端点大多不认这套，请求会在服务端被拒成一句看不懂的 XML。
 *     `WHEN_REQUIRED` 才是"只在协议要求时才带"，也就是不带。
 */
export function createClient(conn: Source): S3Client {
  return new S3Client({
    region: conn.region,
    endpoint: conn.endpoint,
    credentials: { accessKeyId: conn.accessKeyId, secretAccessKey: conn.secretAccessKey },
    forcePathStyle: true,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

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

/** 一页对象，加上"还有下一页"那一点信息 */
export interface ObjectPage {
  rows: ObjectRow[]
  nextToken: string | null
}

export async function listBuckets(client: S3Client): Promise<BucketRow[]> {
  const out = await client.send(new ListBucketsCommand({}))
  return (out.Buckets ?? []).map((b) => ({
    name: b.Name ?? '',
    createdAt: b.CreationDate ? new Date(b.CreationDate).toISOString() : ''
  }))
}

/**
 * 列一个"目录"下的一层：分隔符固定 `/`，所以键里的斜杠在界面上就是目录。
 * 这是 S3 的通用做法——它本来没有目录，前缀加斜杠是唯一能读成层级形状的东西。
 */
export async function listObjects(
  client: S3Client,
  bucket: string,
  prefix: string,
  token?: string
): Promise<ObjectPage> {
  const out = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix === '' ? undefined : prefix,
      Delimiter: '/',
      MaxKeys: 500,
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

export interface ObjectMeta {
  size: number
  contentType: string
  lastModified: string
}

export async function headObject(client: S3Client, bucket: string, key: string): Promise<ObjectMeta> {
  const out = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
  return {
    size: out.ContentLength ?? 0,
    contentType: out.ContentType ?? '',
    lastModified: out.LastModified ? new Date(out.LastModified).toISOString() : ''
  }
}

/** 取回整个对象。预览与下载都走这一条，字节留在渲染进程里，不落在磁盘上 */
export async function getObjectBytes(client: S3Client, bucket: string, key: string): Promise<Uint8Array> {
  const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  if (!out.Body) return new Uint8Array()
  return new Uint8Array(await out.Body.transformToByteArray())
}

export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<void> {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }))
}

export async function deleteObject(client: S3Client, bucket: string, key: string): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
}

export async function createBucket(client: S3Client, bucket: string): Promise<void> {
  await client.send(new CreateBucketCommand({ Bucket: bucket }))
}

/**
 * 一条有时效的读链接。
 *
 * 有效期是"这链接给别人能用多久"，界面上只给一档默认一小时；签好名的地址本身不含密钥，
 * 拿到它的人在那一段时间里就能读这个对象——所以它是"临时"的，值得界面上把秒数念出来。
 */
export async function presignGet(client: S3Client, bucket: string, key: string, seconds = 3600): Promise<string> {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: seconds })
}

/**
 * 新建桶时先在本地判这几条，判出来的原因要能读。
 *
 * 只收**不含句点**的名字：这样 S3 那侧关于句点的几条规矩（不能相邻、不能是 IP 形式）
 * 根本用不上，也就不需要在这里复述一遍别家的规范。
 * 剩下的规矩（区域特有的长度、保留名）交给端点，它拒了就把它的原话念出来。
 * 返回空串就是合格。
 */
export function validateBucketName(name: string): string {
  if (name === '') return '桶名是空的'
  if (name.length < 3 || name.length > 63) return `桶名要 3 到 63 个字符，现在 ${name.length} 个`
  if (!/^[a-z0-9-]+$/.test(name)) return '桶名只能用小写字母、数字与连字符'
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return '桶名首尾要是字母或数字'
  return ''
}

/** 人读的大小：整块存储的字节数在界面上念成一串数字没人看得懂 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 人读的时间：只到分钟，秒在文件列表里没意义 */
export function formatTime(iso: string): string {
  if (iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * SDK 抛回来的错是 JS 对象（`$metadata`、`Code` 这些），界面要念的是一句话。
 * 端点连不上与密钥不对是两种完全不同的下一步，所以这里把它们分开说。
 */
export function errorText(error: unknown): string {
  const e = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number }; Code?: string }
  const name = e?.name ?? ''
  const code = e?.Code ?? ''
  const status = e?.$metadata?.httpStatusCode ?? 0

  if (name === 'NoSuchBucket' || code === 'NoSuchBucket') return '这个桶不存在'
  if (status === 403 || name === 'AccessDenied' || code === 'AccessDenied') return '端点拒绝了这个密钥（403）'
  if (status === 404) return '端点上找不到这个东西（404）'
  // 端口写错、服务没起、地址拼不上——这几类在 Node 与浏览器里各有各的话，都归到"连不上"
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network|ERR_/i.test(`${name} ${e?.message ?? ''}`)) {
    return `连不上端点（${e?.message ?? name}）`
  }
  if (name === 'SignatureDoesNotMatch' || code === 'SignatureDoesNotMatch') {
    return '签名对不上：Secret Key 或区域填错了'
  }
  const message = (e?.message ?? '').trim()
  return message === '' ? '端点返回了没认出来的错误' : message
}
