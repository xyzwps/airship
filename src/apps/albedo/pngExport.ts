/**
 * SVG 串 → PNG 字节：导出 PNG 的那一步真把矢量铺到栅格上。
 *
 * 走浏览器自己的光栅化：SVG 串成 `blob:` URL（包的 CSP 里 `img-src` 有 `blob:`）交给 Image，
 * 画进 canvas 再 `toBlob('image/png')`。文字层在这一步之前就被描成轮廓，
 * 所以这里不依赖本机装着什么字体——交出去的位图和导出的 SVG 是同一份内容。
 *
 * 画不出位图的环境（jsdom、被禁掉 canvas 的窗口）响亮抛错，由调用方念「导出失败：…」；
 * 不静默写出一个空文件。位图真画得对不对归 `just shot` 走查，用例只钉到"写出的是 PNG 那串字节"。
 */

/** 取不到 2D 上下文 / 画不出位图时的话；调用方把它塞进 toast.exportFailed 的 {message} */
const CANNOT_RASTERIZE = '这个环境画不出位图'

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('SVG 位图化失败'))
    img.src = url
  })
}

function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  if (typeof canvas.toBlob !== 'function') return Promise.resolve(null)
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'))
}

/**
 * 按 `scale` 倍把 SVG 光栅成 PNG 字节；宽高用画布的逻辑尺寸，
 * 所以 scale 1 得到的位图与画布同像素（1000×1000 画布 → 1000×1000 PNG）。
 */
export async function svgToPngBytes(
  svg: string,
  width: number,
  height: number,
  scale = 1
): Promise<Uint8Array> {
  const w = Math.max(1, Math.round(Number(width) * scale))
  const h = Math.max(1, Math.round(Number(height) * scale))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }))
  try {
    const img = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error(CANNOT_RASTERIZE)
    ctx.drawImage(img, 0, 0, w, h)
    const blob = await toPngBlob(canvas)
    if (!blob) throw new Error(CANNOT_RASTERIZE)
    return new Uint8Array(await blob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}
