import type { Doc, PathCommand, Shape } from './model.ts'
import { normalizeDoc } from './model.ts'
import { commandsToPath, fontPathCommands, fmt, textBaselineY, type TextFontLike } from './geom.ts'
import { identity, isIdentityMatrix, multiply, parseTransformAttr, type Matrix } from './matrix.ts'
import { findByAlbedoKey } from './svgImport.ts'

/**
 * SVG 导出的两条路径：
 *   exportPatched —— 导入时留了"原始来源"的文档：在来源 DOM 的克隆上就地补丁，
 *     **未改动的元素连属性顺序都不变**（沿用原节点），改过的换成按模型重建的节点，
 *     并靠祖先矩阵的逆变换保住视觉位置；
 *   exportFromModel —— 没有来源（画布全手写或来源丢了）时整幅重画：两空格缩进、2 位小数。
 *
 * 两条路径的数字精度不同（补丁 6 位、整幅 2 位），这是原行为，不是笔误。
 * 桌布与画布背景色都不进导出——界面文案向用户承诺过。
 */

export const SVG_NS = 'http://www.w3.org/2000/svg'

export function escapeXml(v: unknown): string {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** fontFamily(postscriptName) → 已加载的 opentype 字体，或 null */
export type FontsOf = (postscriptName: string) => { font: TextFontLike & Parameters<typeof fontPathCommands>[0] } | null

/* ---------------- 整幅重画：字符串序列化（2 位小数） ---------------- */

/** 单个形状 → 带两空格缩进的一行（或一组两行）；空串 = 这个形状不进导出 */
export function serializeShapeToText(shape: Shape, fontsOf: FontsOf): string {
  const style: string[] = []
  const fill = shape.type === 'line' ? 'none' : shape.fill
  style.push(`fill="${escapeXml(fill)}"`)
  style.push(`stroke="${escapeXml(shape.stroke)}"`)
  if (shape.strokeWidth) style.push(`stroke-width="${fmt(shape.strokeWidth)}"`)
  style.push('stroke-linecap="round"')
  style.push('stroke-linejoin="round"')
  if (shape.opacity !== 1) style.push(`opacity="${fmt(shape.opacity)}"`)

  switch (shape.type) {
    case 'rect':
      return `  <rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" rx="${fmt(
        Math.min(Math.max(shape.rx, 0), Math.min(shape.w, shape.h) / 2)
      )}" ${style.join(' ')}/>`
    case 'ellipse':
      return `  <ellipse cx="${fmt(shape.cx)}" cy="${fmt(shape.cy)}" rx="${fmt(shape.rx)}" ry="${fmt(shape.ry)}" ${style.join(' ')}/>`
    case 'circle':
      return `  <circle cx="${fmt(shape.cx)}" cy="${fmt(shape.cy)}" r="${fmt(shape.r)}" ${style.join(' ')}/>`
    case 'polygon':
      return `  <polygon points="${escapeXml(
        shape.points.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(' ')
      )}" ${style.join(' ')}/>`
    case 'line':
      return `  <line x1="${fmt(shape.x1)}" y1="${fmt(shape.y1)}" x2="${fmt(shape.x2)}" y2="${fmt(shape.y2)}" ${style.join(' ')}/>`
    case 'text': {
      const entry = shape.fontFamily ? fontsOf(shape.fontFamily) : null
      if (!entry) return ''
      const outline = fontPathCommands(entry.font, shape.text, shape.x, textBaselineY(shape, entry.font), shape.fontSize)
      if (!outline.length) return ''
      return `  <g>\n    <path d="${escapeXml(commandsToPath(outline as unknown as PathCommand[]))}" ${style.join(' ')}\n  </g>`
    }
    case 'path': {
      const rule = shape.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : ''
      return `  <path d="${escapeXml(commandsToPath(shape.commands))}"${rule} ${style.join(' ')}/>`
    }
    default:
      return ''
  }
}

/** 整幅重画：XML 头 + svg 根 + 每个形状一行，文件以换行结尾；画布没有名字，所以不写 <title> */
export function exportFromModel(doc: Doc, fontsOf: FontsOf): string {
  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<svg xmlns="${SVG_NS}" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}">`
  )
  for (const shape of doc.shapes) {
    const line = serializeShapeToText(shape, fontsOf)
    if (line) lines.push(line)
  }
  lines.push('</svg>')
  lines.push('')
  return lines.join('\n')
}

/* ---------------- 补丁式导出：DOM 上的就地替换（6 位小数） ---------------- */

const fmt6 = (v: number): string => fmt(v, 6)

/** 6 位小数版：矩阵 → matrix(a b c d e f) */
export function matrixToTransform(m: Matrix): string {
  return `matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map((v) => String(Number(v.toFixed(6)))).join(' ')})`
}

/** 元素到 root（不含自身、含 root）的累积 transform；style 内 transform 或解析失败判 null */
export function ancestorMatrixChain(el: Element, root: Element): Matrix | null {
  const chain: Element[] = []
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    chain.push(cur)
    if (cur === root) break
  }
  chain.reverse()
  let acc = identity()
  for (const node of chain) {
    if (/(?:^|;)\s*transform\s*:/i.test(node.getAttribute('style') || '')) return null
    const raw = node.getAttribute('transform')
    if (!raw) continue
    const m = parseTransformAttr(raw)
    if (!m) return null
    acc = multiply(acc, m)
  }
  return acc
}

/** 形状 → 真 SVGElement（6 位小数）；文字缺字体返回 null（调用方保留原节点） */
export function createShapeElement(shape: Shape, fontsOf: FontsOf): Element | null {
  const paint: Record<string, string | number> = {
    fill: shape.type === 'line' ? 'none' : shape.fill,
    stroke: shape.stroke,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round'
  }
  if (shape.strokeWidth) paint['stroke-width'] = fmt6(shape.strokeWidth)
  if (shape.opacity !== 1) paint['opacity'] = fmt6(shape.opacity)

  const el = (tag: string, attrs: Record<string, string | number | null | undefined>): Element => {
    const node = document.createElementNS(SVG_NS, tag)
    Object.entries(attrs).forEach(([k, v]) => {
      if (v !== null && v !== undefined) node.setAttribute(k, String(v))
    })
    return node
  }

  switch (shape.type) {
    case 'rect':
      return el('rect', {
        ...paint,
        x: fmt6(shape.x),
        y: fmt6(shape.y),
        width: fmt6(shape.w),
        height: fmt6(shape.h),
        rx: fmt6(Math.min(Math.max(shape.rx, 0), Math.min(shape.w, shape.h) / 2))
      })
    case 'ellipse':
      return el('ellipse', { ...paint, cx: fmt6(shape.cx), cy: fmt6(shape.cy), rx: fmt6(shape.rx), ry: fmt6(shape.ry) })
    case 'circle':
      return el('circle', { ...paint, cx: fmt6(shape.cx), cy: fmt6(shape.cy), r: fmt6(shape.r) })
    case 'polygon':
      return el('polygon', {
        ...paint,
        points: shape.points.map((p) => `${fmt6(p.x)},${fmt6(p.y)}`).join(' ')
      })
    case 'line':
      return el('line', { ...paint, x1: fmt6(shape.x1), y1: fmt6(shape.y1), x2: fmt6(shape.x2), y2: fmt6(shape.y2) })
    case 'path': {
      const attrs: Record<string, string | number> = { ...paint, d: commandsToPath(shape.commands, 6) }
      if (shape.fillRule === 'evenodd') attrs['fill-rule'] = 'evenodd'
      return el('path', attrs)
    }
    case 'text': {
      const entry = shape.fontFamily ? fontsOf(shape.fontFamily) : null
      if (!entry) return null
      const outline = fontPathCommands(entry.font, shape.text, shape.x, textBaselineY(shape, entry.font), shape.fontSize)
      if (!outline.length) return null
      const g = document.createElementNS(SVG_NS, 'g')
      g.appendChild(el('path', { ...paint, d: commandsToPath(outline as unknown as PathCommand[], 6) }))
      return g
    }
    default:
      return null
  }
}

/* ---------------- "改没改"的判据 ---------------- */

/** 键排序的稳定 JSON——baseline 比对与"未改动"判定共用 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(v as object).sort()) out[key] = sortDeep((v as Record<string, unknown>)[key])
    return out
  }
  return v
}

/**
 * 形状指纹：归一化后剥掉 id/name/sourceKey/visible 与命令 id，只剩几何+样式。
 * 导入时记为 baseline；导出时与当前形状再算一次比相等——相等就连节点都不动。
 * visible 不进指纹：隐藏只是编辑时的清场，不该让一份原稿在导出时变了写法。
 */
export function shapeSignature(shape: Shape): string {
  const normalized = normalizeDoc({ width: 64, height: 64, shapes: [shape] }, 'en').shapes[0] as
    | (Shape & { sourceKey?: string })
    | undefined
  if (!normalized) return ''
  const clone = JSON.parse(JSON.stringify(normalized)) as Shape & { sourceKey?: string }
  delete (clone as { id?: string }).id
  delete (clone as { name?: string }).name
  delete (clone as { visible?: boolean }).visible
  delete clone.sourceKey
  if (clone.type === 'path') {
    clone.commands = clone.commands.map((c) => {
      const copy = { ...(c as unknown as Record<string, unknown>) }
      delete copy.id
      return copy as unknown as PathCommand
    })
  }
  return canonicalJson(clone)
}

export interface SourceEntryRecord {
  key: string
  baseline: string
  ancestorOpacity: number
}

export interface SourceDocState {
  doc: Document
  root: Element
  entries: Map<string, SourceEntryRecord>
}

/** 祖先 opacity 除法：模型里的透明度已经乘过祖先那份，重建的节点仍挂在同一祖先下 */
export function divideAncestorOpacity(shape: Shape, entry: SourceEntryRecord): Shape {
  const v = Number(entry.ancestorOpacity)
  if (!(v > 0) || Math.abs(v - 1) < 1e-9) return shape
  return { ...shape, opacity: Math.min(1, Math.max(0, shape.opacity / v)) }
}

/** 只改几何没改外观时，把原元素上的外观属性整体搬到新元素（含 url(#) 引用与 opacity 还原） */
export function carryOriginalPaint(oldEl: Element, newEl: Element, shape: Shape, entry: SourceEntryRecord): void {
  let baseline: Record<string, unknown>
  try {
    baseline = JSON.parse(entry.baseline)
  } catch {
    return
  }
  if (!baseline) return
  const current = normalizeDoc({ width: 64, height: 64, shapes: [shape] }, 'en').shapes[0] as unknown as Record<string, unknown>
  const paintKeys = ['fill', 'stroke', 'strokeWidth', 'opacity', 'fillRule'] as const
  if (!paintKeys.every((k) => current[k] === baseline[k])) return
  const oldFill = oldEl.getAttribute('fill') || ''
  const oldStroke = oldEl.getAttribute('stroke') || ''
  const urlPaint = /^url\(/i.test(oldFill) || /^url\(/i.test(oldStroke)
  const attrs = [
    'fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'paint-order', 'vector-effect',
    'marker-start', 'marker-mid', 'marker-end', 'color-interpolation', 'shape-rendering'
  ]
  attrs.forEach((name) => {
    const v = oldEl.getAttribute(name)
    if (v !== null) newEl.setAttribute(name, v)
  })
  if (urlPaint) {
    const op = oldEl.getAttribute('opacity')
    if (op !== null) newEl.setAttribute('opacity', op)
    else newEl.removeAttribute('opacity')
  }
}

/** 同父节点下的已配对元素按模型顺序重排（注释占位法；一处两个以上才处理） */
export function fixDomOrder(
  workDoc: Document,
  root: Element,
  shapes: Shape[],
  entries: Map<string, SourceEntryRecord>
): void {
  const orderOf = new Map<string, number>()
  shapes.forEach((s, i) => orderOf.set(s.id, i))
  const byParent = new Map<Element, Array<{ element: Element; order: number | undefined }>>()
  for (const shape of shapes) {
    const entry = entries.get(shape.id)
    if (!entry) continue
    const el = findByAlbedoKey(root, entry.key)
    if (!el || !el.parentNode) continue
    const parent = el.parentNode as Element
    if (!byParent.has(parent)) byParent.set(parent, [])
    byParent.get(parent)!.push({ element: el, order: orderOf.get(shape.id) })
  }
  byParent.forEach((list, parent) => {
    const seen = new Set<Element>()
    const uniq = list.filter((item) => (seen.has(item.element) ? false : (seen.add(item.element), true)))
    if (uniq.length < 2) return
    const current = uniq
      .map((item) => ({ ...item, slot: Array.prototype.indexOf.call(parent.childNodes, item.element) }))
      .sort((a, b) => a.slot - b.slot)
    const wanted = current.slice().sort((a, b) => (a.order as number) - (b.order as number))
    if (wanted.every((item, i) => item.element === current[i]!.element)) return
    const placeholders = current.map((item) => {
      const ph = workDoc.createComment('albedo-order')
      parent.replaceChild(ph, item.element)
      return ph
    })
    placeholders.forEach((ph, i) => parent.replaceChild(wanted[i]!.element, ph))
  })
}

export interface PatchedExportInput {
  source: SourceDocState
  doc: Doc
  fontsOf: FontsOf
}

/**
 * 补丁式导出；没有来源文档时返回 **null**，调用方回落整幅重画。
 *
 * 步骤：覆写根尺寸 → 摘掉根上的 <title>（画布没有名字）→ 已配对元素按模型顺序重排 → 逐形状：
 * 无 entry/查无原节点 → 新元素追到根尾；指纹相等 → 原节点整个不动；改过 → 重建 +
 * 搬外观 + 逆变换保位置（变换链不支持时退化为"摘原节点、挂根尾"）→ 删除模型里已不存在的原节点 → 清配对键。
 */
export function exportPatched(input: PatchedExportInput): string | null {
  const { source, doc, fontsOf } = input
  if (!source?.doc) return null
  const clone = source.doc.cloneNode(true) as Document
  const root = clone.documentElement

  root.setAttribute('width', String(doc.width))
  root.setAttribute('height', String(doc.height))
  root.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`)

  for (const child of Array.from(root.children)) {
    if (child.nodeName.toLowerCase() === 'title') root.removeChild(child)
  }

  fixDomOrder(clone, root, doc.shapes, source.entries)

  for (const shape of doc.shapes) {
    const entry = source.entries.get(shape.id)
    const old = entry ? findByAlbedoKey(root, entry.key) : null
    if (!entry || !old) {
      const fresh = createShapeElement(shape, fontsOf)
      if (fresh) root.appendChild(fresh)
      continue
    }
    if (shapeSignature(shape) === entry.baseline) continue
    const built = createShapeElement(divideAncestorOpacity(shape, entry), fontsOf)
    if (!built) continue
    carryOriginalPaint(old, built, shape, entry)
    built.setAttribute('id', old.getAttribute('id') || entry.key)
    for (const attr of ['filter', 'clip-path', 'mask']) {
      const v = old.getAttribute(attr)
      if (v !== null) built.setAttribute(attr, v)
    }
    const chain = ancestorMatrixChain(old, root)
    const inv = chain ? invert6(chain) : null
    if (inv === null) {
      old.parentNode?.removeChild(old)
      root.appendChild(built)
      continue
    }
    if (!isIdentityMatrix(inv)) built.setAttribute('transform', matrixToTransform(inv))
    old.parentNode?.replaceChild(built, old)
  }

  const liveIds = new Set(doc.shapes.map((shape) => shape.id))
  for (const [shapeId, entry] of source.entries) {
    if (liveIds.has(shapeId)) continue
    const el = findByAlbedoKey(root, entry.key)
    if (el?.parentNode) el.parentNode.removeChild(el)
  }
  Array.from(root.querySelectorAll('[data-albedo-key]')).forEach((el) => el.removeAttribute('data-albedo-key'))

  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`
}

function invert6(m: Matrix): Matrix | null {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) <= 1e-9) return null
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det
  }
}

/** 命令数组序列化到任意精度（pathCode 预览用 2 位，导出用 6 位） */
export { commandsToPath }
