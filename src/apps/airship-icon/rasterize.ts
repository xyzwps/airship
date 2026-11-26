/**
 * 渲染侧光栅化：SVG → 各尺寸 PNG，靠的是窗口自己的 Chromium，不装任何原生依赖。
 *
 * 这条选择是有代价的，写清楚：画布读不出像素时（污染）只能报错，不能兜底；
 * 而"曾经装在仓里的那份 `@resvg/resvg-js`"随转图标脚本一起于 2026-11-26 退场了
 * （AGENTS.md 本机事实：全仓不再有任何转换步骤，出图归外部工具——这个应用就是那个外部工具）。
 *
 * jsdom 没有 2D 画布，所以这一层不进用例：判据在 `ico.ts` / `svgFit.ts` 那两层的纯函数上，
 * "真画出来了"归截图走查。
 */
import { ICON_FRAME_SIZES, type IcoFrame } from './ico.ts'
import { mayTaintCanvas, svgBox, withRootSize } from './svgFit.ts'

export const TAINTED_MESSAGE = '画不动这份 SVG：它含 foreignObject 或外部引用，浏览器不把像素交出来。'
export const BROKEN_SVG_MESSAGE = '这份 SVG 读不开：根标签没闭合，或语法有问题。'

/** 一份 SVG 出 `sizes` 这几档方图 PNG（透明底、保持宽高比、居中） */
export async function svgToFrames(svgText: string, sizes: readonly number[] = ICON_FRAME_SIZES): Promise<IcoFrame[]> {
  if (mayTaintCanvas(svgText)) throw new Error(TAINTED_MESSAGE)
  const box = svgBox(svgText)
  const url = URL.createObjectURL(new Blob([withRootSize(svgText, box.width, box.height)], { type: 'image/svg+xml' }))
  try {
    const img = await load(url)
    const frames: IcoFrame[] = []
    for (const size of sizes) frames.push({ size, png: await paint(img, box, size) })
    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 单张 `icon.png`：与 ico 里的帧同一画法，只是边长由界面填 */
export async function svgToPng(svgText: string, size: number): Promise<Uint8Array> {
  const [frame] = await svgToFrames(svgText, [size])
  return frame!.png
}

function load(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(BROKEN_SVG_MESSAGE))
    img.src = url
  })
}

async function paint(img: HTMLImageElement, box: SvgSize, size: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('这台机器上没有 2D 画布，出不了图。')
  // naturalWidth 在部分引擎里对没写宽高的 SVG 给 0，那就退回 viewBox 量出来的那对数
  const w = img.naturalWidth || box.width
  const h = img.naturalHeight || box.height
  const k = Math.min(size / w, size / h)
  const dw = Math.max(1, Math.round(w * k))
  const dh = Math.max(1, Math.round(h * k))
  ctx.clearRect(0, 0, size, size)
  ctx.drawImage(img, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh)
  return pngBytes(canvas)
}

type SvgSize = { width: number; height: number }

async function pngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  let blob: Blob | null
  try {
    blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  } catch {
    throw new Error(TAINTED_MESSAGE)
  }
  if (!blob) throw new Error(TAINTED_MESSAGE)
  return new Uint8Array(await blob.arrayBuffer())
}
