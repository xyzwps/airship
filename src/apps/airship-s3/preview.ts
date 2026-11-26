import { decodeText } from '@airship/textdecode'

/**
 * 预览这一格能显示什么。
 *
 * 判据只有两条：**类型认得出**且**不太大**。认不出的一律不预览——
 * 一个桌面客户端把未知字节硬塞进 `<img>` 或 `<pre>` 里，画出来的东西比不画更容易误导人。
 *
 * 上限 8 MiB 是这一层的设计决定：预览是为了"看一眼是不是这个文件"，
 * 要看内容就下载，要给别人看就复制链接，没必要为一眼把八兆以上搬进内存。
 */
export const PREVIEW_MAX = 8 * 1024 * 1024

export type Preview =
  | { kind: 'image'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'none'; reason: string }

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']
const TEXT_TYPES = ['text/', 'application/json', 'application/xml', 'application/x-yaml', 'image/svg+xml']

function nameOf(key: string): string {
  const slash = key.lastIndexOf('/')
  return slash < 0 ? key : key.slice(slash + 1)
}

function extOf(key: string): string {
  const dot = nameOf(key).lastIndexOf('.')
  return dot < 0 ? '' : key.slice(dot + 1).toLowerCase()
}

const TEXT_EXTS = ['txt', 'md', 'json', 'csv', 'log', 'yml', 'yaml', 'ini', 'conf', 'ts', 'tsx', 'js', 'css', 'html', 'sh', 'py']

/** 超过上限时念的那一句：大小报的是端点说的数，不是读回来的字节数 */
export function tooBigReason(bytes: number): string {
  return `有 ${Math.round(bytes / 1024 / 1024)} MB，超过预览的 8 MB`
}

/**
 * 出一个预览。`contentType` 是端点存的，可能为空或不准（上传时没写类型的那些），
 * 所以类型认不出来时按扩展名再判一次——这不是猜，是这一类客户端的通行做法。
 */
export function makePreview(key: string, contentType: string, bytes: Uint8Array): Preview {
  if (bytes.byteLength > PREVIEW_MAX) return { kind: 'none', reason: tooBigReason(bytes.byteLength) }
  const type = contentType.toLowerCase()
  const ext = extOf(key)

  if (IMAGE_TYPES.some((t) => type.startsWith(t)) || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
    // blob: 在 CSP 的 img-src 里是放行的，这一条不是新开的口子
    const mime = type.includes('image/') ? type.split(';')[0] : `image/${ext === 'jpg' ? 'jpeg' : ext}`
    const blob = new Blob([bytes.slice()], { type: mime })
    return { kind: 'image', url: URL.createObjectURL(blob) }
  }

  // 端点没写类型时不猜"那就是文本"：只有扩展名落在这一小张表里才按文本读
  const looksText = TEXT_TYPES.some((t) => type.startsWith(t)) || TEXT_EXTS.includes(ext)

  if (looksText) {
    return { kind: 'text', text: decodeText(bytes) }
  }

  return { kind: 'none', reason: `这种类型不预览（${type === '' ? ext || '未知' : type}）` }
}
