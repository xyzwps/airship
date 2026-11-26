/**
 * SVG 的取景判定：只动字符串，不碰画布，所以 jsdom 里验得动。
 *
 * 为什么要判：`<img>` 加载一份 SVG 时，根标签没有可用的数字宽高，Chromium 就按 300×150 那块
 * 默认盒子画——直接 drawImage 到 256×256 的画布上，图标会歪成一条横杠。
 * 所以出图前先把根标签的 width/height 写成 viewBox 的那对数，让图片有确定的原始尺寸。
 */

export interface SvgBox {
  width: number
  height: number
  /** 数字从哪儿来的：viewBox / 根标签的 width+height / 都没写于是按方图兜底 */
  from: 'viewBox' | 'attr' | 'fallback'
}

const ROOT_TAG = /<svg\b[^>]*>/i
const ATTR = (name: string, tag: string): string | null =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? null

/** 是 SVG 吗：只看根标签在不在，注释与 XML 声明不算 */
export function looksLikeSvg(text: string): boolean {
  return ROOT_TAG.test(text.trim())
}

/** 量出这份 SVG 的原始比例 */
export function svgBox(text: string): SvgBox {
  const tag = ROOT_TAG.exec(text)?.[0] ?? ''
  const view = ATTR('viewBox', tag)
  if (view) {
    const nums = view.trim().split(/[\s,]+/).map(Number)
    const w = nums[2]
    const h = nums[3]
    if (nums.length >= 4 && Number.isFinite(w) && Number.isFinite(h) && w! > 0 && h! > 0) {
      return { width: w!, height: h!, from: 'viewBox' }
    }
  }
  const w = numberAttr(ATTR('width', tag))
  const h = numberAttr(ATTR('height', tag))
  if (w && h) return { width: w, height: h, from: 'attr' }
  return { width: 100, height: 100, from: 'fallback' }
}

/** `width="96"` 与 `width="96px"` 都要认；`100%` 这类相对值认不出来（没有参照物） */
function numberAttr(raw: string | null): number | null {
  if (!raw) return null
  const n = Number(raw.trim().replace(/px$/i, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 把根标签的 width/height 钉成这对数（其余一字不动） */
export function withRootSize(text: string, width: number, height: number): string {
  const m = ROOT_TAG.exec(text)
  if (!m) return text
  const tag = m[0]
    .replace(/\s(width|height)\s*=\s*["'][^"']*["']/gi, '')
    .replace(/^<svg/i, `<svg width="${width}" height="${height}"`)
  return text.slice(0, m.index) + tag + text.slice(m.index + m[0].length)
}

/** 含 foreignObject 或外部引用的 SVG 会污染画布，浏览器不让读出像素——先认出来，好念人话 */
export function mayTaintCanvas(text: string): boolean {
  return /<foreignObject\b/i.test(text) || /\bhref\s*=\s*["'](?!#|data:)/i.test(text)
}
