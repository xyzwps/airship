import type { AppApi } from '../shell/useAppApi'

/**
 * 把壳的范围读包装成 foliate-js 需要的 File-like。
 *
 * 关键点：slice(from, to) 不是一次性读整本，而是返回一个"用到才去取字节"的
 * 懒 Blob。foliate 渲染某一节时只会 slice 那一节用到的范围，
 * 大书（几百 MB 的扫描版除外）内存占用和首开速度都靠这个。
 *
 * 这条思路直接继承自 RN 版 reader.js 的 lazyBlob/remoteFile，
 * 只是取字节的通道从 base64 消息桥换成了直接 IPC（返回 Uint8Array，省一次编解码）。
 */

const CHUNK = 0x10000

export interface RemoteFile {
  name: string
  type: string
  size: number
  slice(from?: number, to?: number): unknown
  arrayBuffer(): Promise<ArrayBuffer>
}

function lazyBlob(api: AppApi, path: string, start: number, length: number) {
  let cache: Promise<Blob> | null = null

  const load = async (): Promise<Blob> => {
    const chunks: Uint8Array[] = []
    let done = 0
    while (done < length) {
      const want = Math.min(CHUNK, length - done)
      const bytes = await api.fs.readRange(path, start + done, want)
      chunks.push(bytes)
      done += bytes.length
      if (bytes.length === 0) break
    }
    return new Blob(chunks as BlobPart[], { type: 'application/octet-stream' })
  }

  const blob = (): Promise<Blob> => (cache ??= load())

  return {
    size: length,
    type: '',
    arrayBuffer: async () => (await blob()).arrayBuffer(),
    text: async () => (await blob()).text(),
    blob,
    stream: async () => (await blob()).stream()
  }
}

export function remoteFile(api: AppApi, path: string, size: number, name: string): RemoteFile {
  return {
    name,
    type: 'application/octet-stream',
    size,
    slice: (from = 0, to = size) => lazyBlob(api, path, from, Math.max(0, Math.min(to, size) - from)),
    arrayBuffer: async () => (await lazyBlob(api, path, 0, size).blob()).arrayBuffer()
  }
}
