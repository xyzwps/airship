import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand
} from '@aws-sdk/client-s3'
import type { AppApi } from '@airship/contract'
import type { S3Client } from '@aws-sdk/client-s3'
import { getObjectBytes, headObject, putObject } from './client.ts'

/**
 * 上传与下载：本地文件与对象之间那一段路。
 *
 * 字节只能经 `api.fs.*` 进出（渲染进程没有文件系统），所以这两件事都有上限，
 * 上限是**这层的设计决定**，不是端点的：
 *
 *   - 上传：超过 `MULTIPART_FROM` 的文件走分段，每次只把 8 MiB 读进内存（`fs.readRange`），
 *     所以大文件不吃内存，只花时间；
 *   - 下载：一次接一整份再落盘，没有"边接边写"的通道，所以超过 `DOWNLOAD_MAX` 的直接拒，
 *     拒的话要说清是多大、上限是多少（册子 OS-010 钉这句）。
 */

/** 到这个数以上就分段（S3 的分段最小 5 MiB，最后一块除外） */
export const MULTIPART_FROM = 32 * 1024 * 1024
/** 分段大小 */
export const PART_SIZE = 8 * 1024 * 1024
/** 一次下载的上限 */
export const DOWNLOAD_MAX = 256 * 1024 * 1024

/** 上传一颗本地文件；`onPart` 用来把"第几段"念到界面上 */
export async function uploadFile(
  api: AppApi,
  client: S3Client,
  bucket: string,
  key: string,
  filePath: string,
  contentType: string,
  onPart?: (done: number, total: number) => void
): Promise<number> {
  const stat = await api.fs.stat(filePath)
  if (!stat) throw new Error('读不到这个文件')
  const size = stat.size

  if (size < MULTIPART_FROM) {
    onPart?.(1, 1)
    const bytes = await api.fs.read(filePath)
    await putObject(client, bucket, key, bytes, contentType)
    return size
  }

  const total = Math.ceil(size / PART_SIZE)
  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType })
  )
  const uploadId = created.UploadId ?? ''
  const parts: { PartNumber: number; ETag?: string }[] = []
  try {
    for (let i = 0; i < total; i += 1) {
      const start = i * PART_SIZE
      const bytes = await api.fs.readRange(filePath, start, Math.min(PART_SIZE, size - start))
      const out = await client.send(
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: i + 1, Body: bytes })
      )
      parts.push({ PartNumber: i + 1, ETag: out.ETag })
      onPart?.(i + 1, total)
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
  return size
}

/**
 * 下载一个对象到本地路径。
 *
 * 先 HEAD 一次拿大小：太大就在**动手之前**拒掉，而不是接了一半内存炸了再说。
 */
export async function downloadObject(
  api: AppApi,
  client: S3Client,
  bucket: string,
  key: string,
  destPath: string
): Promise<number> {
  const meta = await headObject(client, bucket, key)
  if (meta.size > DOWNLOAD_MAX) {
    throw new Error(`这个对象有 ${mb(meta.size)}，超过一次能接的 ${mb(DOWNLOAD_MAX)}`)
  }
  const bytes = await getObjectBytes(client, bucket, key)
  await api.fs.write(destPath, bytes)
  return bytes.byteLength
}

/** 整数 MB 的人读说法，拒一句的时候要说得出两个数 */
function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

/**
 * 上传时要写进对象的内容类型。
 *
 * 只认这一小张表：认不出的一律 `application/octet-stream`，
 * 那正是 S3 自己的默认值——猜一个 `text/plain` 反而会把二进制文件在浏览器里打开成乱码。
 */
const TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf'
}

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** 键与本地文件名之间的那道拼接：当前前缀 + 文件名，斜杠不重复 */
export function joinKey(prefix: string, fileName: string): string {
  return prefix === '' ? fileName : `${prefix}${fileName}`
}
