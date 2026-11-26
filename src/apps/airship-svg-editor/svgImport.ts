import { ensurePaper, paperScope } from './paperRuntime.ts'
import { parsePathCommands } from './pathdata.ts'
import type { LoosePathCommand, ShapeType } from './model.ts'
import {
  IDENTITY,
  applyMatrix,
  identity,
  isIdentityMatrix,
  matrixToSvgTransform,
  multiply,
  parseTransformAttr,
  transformArc,
  viewBoxToFit,
  type Matrix
} from './matrix.ts'

/**
 * SVG 导入：文件文本 → 可编辑形状 + "原始来源"登记。
 *
 * 三条主干：
 *   1. 归一化 DOM（根尺寸统一成 width/height + viewBox="0 0 W H"，根上的
 *      opacity/transform 搬进包装 <g>），然后按文档序给可绘制元素分配配对键
 *      （现有 id 可信就沿用，否则 albedo-src-N）——导出时"未改动的元素沿用原节点"靠它。
 *   2. Paper 的 importSVG(expandShapes) 负责把 path/rect/… 统一成几何；
 *      快路先试"从原始 DOM 直接还原件"（rect/circle/ellipse/line/polygon 在可表达的
 *      变换下保留图元身份），path/polyline 走原始 d 串直解，最后才落 Paper 曲线化。
 *   3. 渐变一律简化为纯色（第一个不透明色标），色标 alpha 并进整体 opacity。
 *
 * 位图（Raster）、文本（PointText）、符号（SymbolItem）不导入，计入 warnings.skipped；
 * 剪裁/蒙版树内与 visible=false 的元素静默跳过、不计数。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const CSS_UNITS: Record<string, number> = { in: 96, pt: 96 / 72, pc: 96 / 6, cm: 96 / 2.54, mm: 96 / 25.4 }
const COINCIDE = 1e-7
const NEAR_TOL = 1e-6

/** 参与来源配对的元素（text/g/image 不在其列） */
const DRAWABLE_SELECTOR = 'path, rect, circle, ellipse, line, polygon, polyline, use'

const DEFINITION_TAGS = new Set(['defs', 'symbol', 'clippath', 'mask', 'pattern'])
/** 不该被搬进包装 <g> 的非绘制子节点 */
const NON_PAINTING_TAGS = new Set([
  'defs', 'style', 'title', 'desc', 'metadata', 'script', 'symbol', 'marker',
  'pattern', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'filter'
])

/* ---------------- 数值 ---------------- */

function round3(v: unknown): number {
  const r = Math.round(Number(v) * 1e3) / 1e3
  return Object.is(r, -0) ? 0 : r
}

/** CSS 长度 → px（96dpi 族换算；% em 等一律落回 fallback；允许无单位） */
export function parseCssLength(raw: string | null | undefined, fallback: number): number {
  if (raw === null || raw === '') return fallback
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(px|in|pt|pc|cm|mm)?$/.exec(String(raw).trim())
  if (!m) return fallback
  return Number(m[1]) * (m[2] ? CSS_UNITS[m[2]]! : 1)
}

/* ---------------- DOM 读取 ---------------- */

interface ElementGeometry {
  [key: string]: number | Array<{ x: number; y: number }> | string | null | undefined
}

function tagName(el: Element): string {
  return el.nodeName.toLowerCase()
}

function attrNumber(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name)
  if (raw === null || !raw.trim()) return fallback
  return parseCssLength(raw, NaN)
}

/** polygon/polyline 点列：至少 6 个有限数且成对，否则 null */
function parsePointsAttr(value: string | null): Array<{ x: number; y: number }> | null {
  if (!value) return null
  const nums = value
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (nums.length < 6 || nums.length % 2 !== 0 || !nums.every(Number.isFinite)) return null
  const pts: Array<{ x: number; y: number }> = []
  for (let i = 0; i < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! })
  return pts
}

function readElementGeometry(el: Element, tag: string): ElementGeometry | null {
  switch (tag) {
    case 'rect':
      return {
        x: attrNumber(el, 'x', 0),
        y: attrNumber(el, 'y', 0),
        width: attrNumber(el, 'width', NaN),
        height: attrNumber(el, 'height', NaN),
        rx: attrNumber(el, 'rx', NaN),
        ry: attrNumber(el, 'ry', NaN)
      }
    case 'circle':
      return { cx: attrNumber(el, 'cx', 0), cy: attrNumber(el, 'cy', 0), r: attrNumber(el, 'r', NaN) }
    case 'ellipse':
      return {
        cx: attrNumber(el, 'cx', 0),
        cy: attrNumber(el, 'cy', 0),
        rx: attrNumber(el, 'rx', NaN),
        ry: attrNumber(el, 'ry', NaN)
      }
    case 'line':
      return {
        x1: attrNumber(el, 'x1', 0),
        y1: attrNumber(el, 'y1', 0),
        x2: attrNumber(el, 'x2', 0),
        y2: attrNumber(el, 'y2', 0)
      }
    case 'polygon':
    case 'polyline': {
      const points = parsePointsAttr(el.getAttribute('points'))
      return points ? { points } : null
    }
    case 'path': {
      const d = (el.getAttribute('d') || '').trim()
      return d ? { d } : null
    }
    case 'use': {
      const href = el.getAttribute('href') || el.getAttribute('xlink:href') || ''
      return href ? { href } : null
    }
    default:
      return null
  }
}

function isInDefinitionTree(node: Element): boolean {
  let cur = node.parentElement
  while (cur) {
    if (DEFINITION_TAGS.has(tagName(cur))) return true
    cur = cur.parentElement
  }
  return false
}

function hasTransformInStyle(node: Element): boolean {
  const style = node.getAttribute('style') || ''
  return /(?:^|;)\s*transform\s*:/i.test(style)
}

/* ---------------- 根归一化与配对键 ---------------- */

interface PreparedSvg {
  text: string
  source: { width: number | null; height: number | null }
  root: Element
  viewBox: number[] | null
  viewport: { width: number | null; height: number | null }
  elements: Map<string, SourceEntry>
  sourceDoc: Document
  sourceRoot: Element
}

export interface SourceEntry {
  working: Element
  exported: Element
  tag: string
  attrs: ElementGeometry
}

interface ParsedSvg {
  parsed: Document
  root: Element
  viewBox: number[] | null
  width: number | null
  height: number | null
}

function parseSvgDocument(text: string): ParsedSvg {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = parsed.documentElement
  if (!root || tagName(root) !== 'svg' || parsed.querySelector('parsererror')) {
    throw new Error('Invalid SVG')
  }
  const vbRaw = (root.getAttribute('viewBox') || '').trim()
  let viewBox: number[] | null = null
  if (vbRaw) {
    const nums = vbRaw.split(/[\s,]+/).map(Number)
    if (nums.length === 4 && nums.every(Number.isFinite) && (nums[2] as number) > 0 && (nums[3] as number) > 0) {
      viewBox = nums
    }
  }
  const width = parseCssLength(root.getAttribute('width'), viewBox ? viewBox[2]! : NaN)
  const height = parseCssLength(root.getAttribute('height'), viewBox ? viewBox[3]! : NaN)
  return {
    parsed,
    root,
    viewBox,
    width: Number.isFinite(width) ? width : null,
    height: Number.isFinite(height) ? height : null
  }
}

/** 把根统一成"有 width/height 且 viewBox=0 0 w h"；根上的 opacity/非单位 transform 搬进包装 g */
function normalizeRootSize(
  root: Element,
  viewBox: number[] | null,
  width: number | null,
  height: number | null
): { width: number | null; height: number | null; viewBox: number[] | null } {
  const opacityRaw = root.getAttribute('opacity')
  const opacityNum = opacityRaw === null || opacityRaw.trim() === '' ? null : Number(opacityRaw)
  const needsOpacity = opacityNum !== null && Number.isFinite(opacityNum) && opacityNum !== 1

  const wrap = (m: Matrix | null): void => {
    const g = document.createElementNS(SVG_NS, 'g')
    if (m && !isIdentityMatrix(m)) g.setAttribute('transform', matrixToSvgTransform(m))
    if (needsOpacity) {
      g.setAttribute('opacity', String(opacityNum))
      root.removeAttribute('opacity')
    }
    const movers = Array.from(root.childNodes).filter((n) => {
      if (n.nodeType !== 1) return true
      return !NON_PAINTING_TAGS.has(tagName(n as Element))
    })
    movers.forEach((n) => g.appendChild(n))
    root.appendChild(g)
  }

  if (viewBox) {
    const w = Number.isFinite(width as number) && (width as number) > 0 ? (width as number) : viewBox[2]!
    const h = Number.isFinite(height as number) && (height as number) > 0 ? (height as number) : viewBox[3]!
    const fit = viewBoxToFit(viewBox, w, h, root.getAttribute('preserveAspectRatio'))
    root.setAttribute('width', String(w))
    root.setAttribute('height', String(h))
    root.setAttribute('viewBox', `0 0 ${w} ${h}`)
    if (!isIdentityMatrix(fit) || needsOpacity) wrap(fit)
    return { width: w, height: h, viewBox: [0, 0, w, h] }
  }
  const w = Number.isFinite(width as number) && (width as number) > 0 ? (width as number) : null
  const h = Number.isFinite(height as number) && (height as number) > 0 ? (height as number) : null
  if (w !== null) root.setAttribute('width', String(w))
  if (h !== null) root.setAttribute('height', String(h))
  if (needsOpacity) wrap(null)
  return { width: w, height: h, viewBox: null }
}

/** "规范化纯数字串"的 id 不可信（"1"/"1.5"/".5"/"-2"），要重新分配 */
function isNormalizedNumericId(id: string): boolean {
  return /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(id) && String(Number(id)) === id
}

function buildSourceKeyMap(workingRoot: Element, exportedRoot: Element): Map<string, SourceEntry> {
  const working = Array.from(workingRoot.querySelectorAll(DRAWABLE_SELECTOR))
  const exported = Array.from(exportedRoot.querySelectorAll(DRAWABLE_SELECTOR))
  const map = new Map<string, SourceEntry>()
  const idSet = new Set<string>()
  const idCount = new Map<string, number>()
  for (const el of working) {
    const id = el.getAttribute('id')
    if (!id) continue
    idSet.add(id)
    idCount.set(id, (idCount.get(id) ?? 0) + 1)
  }
  let serial = 0
  const nextKey = (): string => {
    let key = `albedo-src-${serial + 1}`
    while (idSet.has(key)) {
      serial += 1
      key = `albedo-src-${serial + 1}`
    }
    serial += 1
    idSet.add(key)
    return key
  }
  const n = Math.min(working.length, exported.length)
  for (let i = 0; i < n; i += 1) {
    const w = working[i]!
    const e = exported[i]!
    if (isInDefinitionTree(w)) continue
    const tag = tagName(w)
    const attrs = readElementGeometry(w, tag)
    if (!attrs) continue
    let key = w.getAttribute('id') || ''
    if (!key || isNormalizedNumericId(key) || (idCount.get(key) ?? 0) > 1) {
      key = nextKey()
      w.setAttribute('id', key)
    }
    e.setAttribute('data-albedo-key', key)
    map.set(key, { working: w, exported: e, tag, attrs })
  }
  return map
}

/** 元素到视口的累计矩阵；defs/use/根 transform/style 内 transform 等判 null（降级通用处理） */
function accumulateElementMatrix(el: Element, prepared: PreparedSvg): Matrix | null {
  const ancestors: Element[] = []
  let cur: Element | null = el
  while (cur && cur !== prepared.root) {
    const t = tagName(cur)
    if (['svg', 'defs', 'symbol', 'use', 'marker', 'pattern', 'clippath', 'mask'].includes(t)) return null
    ancestors.unshift(cur)
    cur = cur.parentElement
  }
  if (cur !== prepared.root) return null
  if ((prepared.root.getAttribute('transform') || '').trim()) return null
  let acc = viewBoxToFit(prepared.viewBox, prepared.viewport.width, prepared.viewport.height, prepared.root.getAttribute('preserveAspectRatio'))
  if (hasTransformInStyle(prepared.root)) return null
  for (const node of [...ancestors]) {
    if (hasTransformInStyle(node)) return null
    const raw = node.getAttribute('transform')
    if (raw === null) continue
    const m = parseTransformAttr(raw)
    if (!m) return null
    acc = multiply(acc, m)
  }
  return acc
}

function prepareSvgSource(text: string): PreparedSvg {
  const parsedDoc = parseSvgDocument(text)
  const cloneDoc = parsedDoc.parsed.cloneNode(true) as Document
  const normalized = normalizeRootSize(parsedDoc.root, parsedDoc.viewBox, parsedDoc.width, parsedDoc.height)
  const cloneRoot = cloneDoc.documentElement
  normalizeRootSize(cloneRoot, parsedDoc.viewBox, parsedDoc.width, parsedDoc.height)
  const elements = buildSourceKeyMap(parsedDoc.root, cloneRoot)
  const prepared: PreparedSvg = {
    text: new XMLSerializer().serializeToString(parsedDoc.parsed),
    source: { width: normalized.width, height: normalized.height },
    root: parsedDoc.root,
    viewBox: normalized.viewBox,
    viewport: { width: normalized.width, height: normalized.height },
    elements,
    sourceDoc: cloneDoc,
    sourceRoot: cloneRoot
  }
  return prepared
}

/* ---------------- paper → 命令 ---------------- */

type LooseCommand = LoosePathCommand

function segmentToLoose(prev: paper.Segment, cur: paper.Segment, out: LooseCommand[]): void {
  const ho = prev.handleOut
  const hi = cur.handleIn
  if (Math.abs(ho.x) < COINCIDE && Math.abs(ho.y) < COINCIDE && Math.abs(hi.x) < COINCIDE && Math.abs(hi.y) < COINCIDE) {
    out.push({ type: 'L', x: round3(cur.point.x), y: round3(cur.point.y) })
    return
  }
  out.push({
    type: 'C',
    x1: round3(prev.point.x + ho.x),
    y1: round3(prev.point.y + ho.y),
    x2: round3(cur.point.x + hi.x),
    y2: round3(cur.point.y + hi.y),
    x: round3(cur.point.x),
    y: round3(cur.point.y)
  })
}

/** 把全局矩阵烘焙进几何的克隆（不插回原树） */
function bakeGlobal(item: paper.Path): paper.Path {
  const copy = item.clone({ insert: false }) as paper.Path
  copy.matrix = new paperScope.Matrix()
  copy.transform(item.globalMatrix)
  return copy
}

function pathItemToCommands(path: paper.Path, out: LooseCommand[]): void {
  const baked = bakeGlobal(path)
  const segs = baked.segments
  if (!segs || !segs.length) return
  out.push({ type: 'M', x: round3(segs[0]!.point.x), y: round3(segs[0]!.point.y) })
  for (let i = 0; i < segs.length - 1; i += 1) segmentToLoose(segs[i]!, segs[i + 1]!, out)
  if (baked.closed) {
    const first = segs[0]!.point
    const last = segs[segs.length - 1]!.point
    const sameEnd = Math.abs(first.x - last.x) < COINCIDE && Math.abs(first.y - last.y) < COINCIDE
    if (segs.length > 1 && !sameEnd) segmentToLoose(segs[segs.length - 1]!, segs[0]!, out)
    out.push({ type: 'Z' })
  }
}

function singlePathToCommands(item: paper.Item): LooseCommand[] {
  const out: LooseCommand[] = []
  if (item.className === 'Path') pathItemToCommands(item as paper.Path, out)
  return out
}

/** CompoundPath 摊平成一条多 M 子路径的命令序列 */
function compoundToCommands(item: paper.Item): LooseCommand[] {
  const out: LooseCommand[] = []
  if (item.className === 'CompoundPath') {
    for (const child of (item as paper.CompoundPath).children) {
      if (child.className === 'Path' && (child as paper.Path).segments.length) {
        pathItemToCommands(child as paper.Path, out)
      }
    }
  }
  return out
}

function roundCommandFields(commands: LooseCommand[]): LooseCommand[] {
  return commands.map((c) => {
    const copy: Record<string, unknown> = { ...c }
    for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2', 'rx', 'ry', 'rotation']) {
      if (typeof copy[key] === 'number' && Number.isFinite(copy[key] as number)) copy[key] = round3(copy[key] as number)
    }
    return copy as unknown as LooseCommand
  })
}

/* ---------------- 样式 ---------------- */

interface PaintInfo {
  hex: string
  alpha: number
  gradient: boolean
}

/** 渐变 → 第一个 alpha>0 的色标（没有就第一标）；这就是"渐变已简化为纯色" */
function colorToPaint(color: paper.Color | null): PaintInfo | null {
  if (!color) return null
  const gradient = (color as { gradient?: { stops?: Array<{ color: paper.Color }> } | null }).gradient
  if (gradient) {
    const stops = gradient.stops ?? []
    const picked = stops.find((s) => s.color.alpha > 0) ?? stops[0]
    if (!picked) return null
    return { hex: picked.color.toCSS(true), alpha: Number.isFinite(picked.color.alpha) ? picked.color.alpha : 1, gradient: true }
  }
  return { hex: color.toCSS(true), alpha: Number.isFinite(color.alpha) ? color.alpha : 1, gradient: false }
}

interface PaperStyle {
  fill: PaintInfo | null
  stroke: PaintInfo | null
  strokeWidth: number
  opacity: number
}

function readPaperStyle(item: paper.Item, inheritedOpacity: number): PaperStyle {
  const node = item as unknown as {
    fillColor?: paper.Color | null
    strokeColor?: paper.Color | null
    strokeWidth?: number
    opacity?: number
  }
  const own = Number.isFinite(node.opacity) ? (node.opacity as number) : 1
  return {
    fill: colorToPaint(node.fillColor ?? null),
    stroke: colorToPaint(node.strokeColor ?? null),
    strokeWidth: Math.max(0, Number(node.strokeWidth) || 0),
    opacity: Math.min(1, Math.max(0, inheritedOpacity * own))
  }
}

/** 样式四件套：渐变的色标 alpha 在这里额外乘进整体 opacity */
function paintToStyle(s: PaperStyle): { fill: string; stroke: string; strokeWidth: number; opacity: number } {
  let opacity = s.opacity
  if (s.fill) opacity *= s.fill.alpha
  else if (s.stroke) opacity *= s.stroke.alpha
  return {
    fill: s.fill ? s.fill.hex : 'none',
    stroke: s.stroke ? s.stroke.hex : 'none',
    strokeWidth: s.strokeWidth,
    opacity: Math.min(1, Math.max(0, opacity))
  }
}

/* ---------------- 导入产出的形状（id/name 由应用层补） ---------------- */

export type ImportedShape =
  | { type: 'rect'; x: number; y: number; w: number; h: number; rx: number } & PaintFields & { sourceKey?: string | null }
  | { type: 'ellipse'; cx: number; cy: number; rx: number; ry: number } & PaintFields & { sourceKey?: string | null }
  | { type: 'circle'; cx: number; cy: number; r: number } & PaintFields & { sourceKey?: string | null }
  | { type: 'polygon'; points: Array<{ x: number; y: number }> } & PaintFields & { sourceKey?: string | null }
  | { type: 'line'; x1: number; y1: number; x2: number; y2: number } & PaintFields & { sourceKey?: string | null }
  | { type: 'path'; commands: LooseCommand[]; fillRule: 'nonzero' | 'evenodd' } & PaintFields & { sourceKey?: string | null }

interface PaintFields {
  fill: string
  stroke: string
  strokeWidth: number
  opacity: number
}

function makePathShape(el: paper.Item, style: PaperStyle, commands: LooseCommand[]): ImportedShape {
  const node = el as unknown as { name?: string; fillRule?: string }
  return {
    type: 'path',
    sourceKey: node.name || null,
    ...paintToStyle(style),
    fillRule: node.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
    commands
  }
}

/** 原始 d 串 / polyline 点列直解的快路（transform 不支持则 null） */
function pathFromOriginalSource(item: paper.Item, prepared: PreparedSvg, usedKeys: Set<string>): LooseCommand[] | null {
  const name = (item as unknown as { name?: string }).name
  if (!name) return null
  const entry = prepared.elements.get(name)
  if (!entry) return null
  let commands: LooseCommand[] | null = null
  if (entry.tag === 'path') {
    commands = parsePathCommands(String(entry.attrs.d || ''))
  } else if (entry.tag === 'polyline') {
    const pts = entry.attrs.points as Array<{ x: number; y: number }> | undefined
    if (Array.isArray(pts) && pts.length) {
      commands = pts.map((p, i) => (i === 0 ? { type: 'M', x: p.x, y: p.y } : { type: 'L', x: p.x, y: p.y }) as LooseCommand)
    }
  }
  if (!commands || !commands.length) return null
  const matrix = accumulateElementMatrix(entry.working, prepared)
  if (!matrix) return null
  const transformed = transformCommandsLoose(commands, matrix)
  if (!transformed.length) return null
  usedKeys.add(name)
  return roundCommandFields(transformed)
}

/** transformCommands 的无 id 版：按联合类型逐条窄化，坐标不舍入 */
function transformCommandsLoose(commands: LooseCommand[], matrix: Matrix): LooseCommand[] {
  const m = { ...matrix }
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  const out: LooseCommand[] = []
  for (const cmd of commands) {
    if (!cmd || !cmd.type) continue
    if (cmd.type === 'Z') {
      out.push({ type: 'Z' })
      cx = sx
      cy = sy
      continue
    }
    if (cmd.type === 'A') {
      const end = applyMatrix(m, cmd.x, cmd.y)
      if (Math.hypot(end.x - cx, end.y - cy) < 1e-9) continue
      const arc = transformArc({ rx: cmd.rx, ry: cmd.ry, rotation: cmd.rotation, largeArc: cmd.largeArc, sweep: cmd.sweep }, m)
      if (arc) out.push({ type: 'A', rx: arc.rx, ry: arc.ry, rotation: arc.rotation, largeArc: arc.largeArc, sweep: arc.sweep, x: end.x, y: end.y })
      else out.push({ type: 'L', x: end.x, y: end.y })
      cx = end.x
      cy = end.y
      continue
    }
    if (cmd.type === 'M' || cmd.type === 'L') {
      const p = applyMatrix(m, cmd.x, cmd.y)
      out.push({ type: cmd.type, x: p.x, y: p.y })
      cx = p.x
      cy = p.y
      if (cmd.type === 'M') {
        sx = p.x
        sy = p.y
      }
      continue
    }
    if (cmd.type === 'Q') {
      const c1 = applyMatrix(m, cmd.x1, cmd.y1)
      const p = applyMatrix(m, cmd.x, cmd.y)
      out.push({ type: 'Q', x1: c1.x, y1: c1.y, x: p.x, y: p.y })
      cx = p.x
      cy = p.y
      continue
    }
    if (cmd.type === 'C') {
      const c1 = applyMatrix(m, cmd.x1, cmd.y1)
      const c2 = applyMatrix(m, cmd.x2, cmd.y2)
      const p = applyMatrix(m, cmd.x, cmd.y)
      out.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y })
      cx = p.x
      cy = p.y
    }
  }
  return out
}

/** 原始图元在可表达变换下还原成 rect/ellipse/circle/line/polygon（path 不走这里） */
function normalizeRectOrEllipse(tag: string, attrs: ElementGeometry, m: Matrix): Record<string, unknown> | null {
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  if (!(sx > 0) || !(sy > 0)) return null
  const scaleRef = Math.max(sx, sy, 1)
  const near = (v: number): boolean => Math.abs(v) <= NEAR_TOL * scaleRef
  const axisAligned = near(m.b) && near(m.c)
  const swapAxes = near(m.a) && near(m.d) && !near(m.b) && !near(m.c)
  const uniformLike =
    Math.abs(sx - sy) <= NEAR_TOL * Math.max(sx, sy) && Math.abs(m.a * m.c + m.b * m.d) <= NEAR_TOL * sx * sy

  if (tag === 'rect') {
    const x = attrs.x as number
    const y = attrs.y as number
    const width = attrs.width as number
    const height = attrs.height as number
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || (!axisAligned && !swapAxes)) return null
    let rx = attrs.rx as number
    let ry = attrs.ry as number
    const hasRx = Number.isFinite(rx)
    const hasRy = Number.isFinite(ry)
    if (!hasRx && !hasRy) {
      rx = 0
      ry = 0
    } else if (hasRy) {
      if (!hasRx) rx = ry
    } else ry = rx
    rx = Math.max(0, Math.min(rx, width / 2))
    ry = Math.max(0, Math.min(ry, height / 2))
    const outRx = swapAxes ? ry * sy : rx * sx
    const outRy = swapAxes ? rx * sx : ry * sy
    if (Math.abs(outRx - outRy) > NEAR_TOL * Math.max(outRx, outRy, 1)) return null
    const p1 = applyMatrix(m, x, y)
    const p2 = applyMatrix(m, x + width, y + height)
    return { type: 'rect', x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y), rx: outRx }
  }

  if (tag === 'circle' || tag === 'ellipse') {
    const cx = attrs.cx as number
    const cy = attrs.cy as number
    const r1 = (tag === 'circle' ? attrs.r : attrs.rx) as number
    const r2 = (tag === 'circle' ? attrs.r : attrs.ry) as number
    if (![cx, cy, r1, r2].every(Number.isFinite) || r1 <= 0 || r2 <= 0) return null
    const isRound = Math.abs(r1 - r2) <= NEAR_TOL * Math.max(r1, r2)
    const center = applyMatrix(m, cx, cy)
    if (isRound) {
      if (uniformLike) return { type: 'circle', cx: center.x, cy: center.y, r: r1 * sx }
      if (axisAligned) return { type: 'ellipse', cx: center.x, cy: center.y, rx: r1 * sx, ry: r1 * sy }
      if (swapAxes) return { type: 'ellipse', cx: center.x, cy: center.y, rx: r1 * sy, ry: r1 * sx }
      return null
    }
    if (axisAligned) return { type: 'ellipse', cx: center.x, cy: center.y, rx: r1 * sx, ry: r2 * sy }
    if (swapAxes) return { type: 'ellipse', cx: center.x, cy: center.y, rx: r2 * sy, ry: r1 * sx }
    return null
  }
  return null
}

function primitiveFromSource(entry: SourceEntry, matrix: Matrix | null, style: PaperStyle): ImportedShape | null {
  if (!entry || !matrix) return null
  let geometry: Record<string, unknown> | null = null
  if (entry.tag === 'rect' || entry.tag === 'circle' || entry.tag === 'ellipse') {
    geometry = normalizeRectOrEllipse(entry.tag, entry.attrs, matrix)
  } else if (entry.tag === 'line') {
    const a = applyMatrix(matrix, entry.attrs.x1 as number, entry.attrs.y1 as number)
    const b = applyMatrix(matrix, entry.attrs.x2 as number, entry.attrs.y2 as number)
    geometry = { type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }
  } else if (entry.tag === 'polygon') {
    const pts = (entry.attrs.points as Array<{ x: number; y: number }>) ?? []
    geometry = { type: 'polygon', points: pts.map((p) => applyMatrix(matrix, p.x, p.y)) }
  }
  if (!geometry) return null
  for (const [key, value] of Object.entries(geometry)) {
    if (typeof value === 'number') geometry[key] = round3(value)
  }
  if (Array.isArray(geometry.points)) {
    geometry.points = geometry.points.map((p: { x: number; y: number }) => ({ x: round3(p.x), y: round3(p.y) }))
  }
  return { ...(geometry as Record<string, unknown>), ...paintToStyle(style) } as unknown as ImportedShape
}

/* ---------------- 主入口 ---------------- */

export interface ImportOutcome {
  shapes: ImportedShape[]
  source: { width: number | null; height: number | null }
  warnings: { gradients: number; skipped: number }
  sourceDoc: Document
  sourceRoot: Element
  sourceElements: Map<string, SourceEntry>
}

export function importSvg(text: string): ImportOutcome {
  const svg = String(text || '').trim()
  if (!svg) throw new Error('Empty SVG')
  const prepared = prepareSvgSource(svg)
  ensurePaper()
  const prevScaleStrokes = paperScope.settings.scaleStrokes
  paperScope.settings.scaleStrokes = true
  let imported: paper.Item | null = null
  let outcome: ImportOutcome | null = null
  try {
    imported = paperScope.project.importSVG(prepared.text, { insert: false, expandShapes: true }) as paper.Item | null
    const shapes: ImportedShape[] = []
    const warnings = { gradients: 0, skipped: 0 }
    const usedKeys = new Set<string>()

    const tryFast = (item: paper.Item, style: PaperStyle): ImportedShape | null => {
      const name = (item as unknown as { name?: string }).name
      if (!name || !prepared.elements || usedKeys.has(name)) return null
      const entry = prepared.elements.get(name)
      if (!entry) return null
      const matrix = accumulateElementMatrix(entry.working, prepared)
      const shape = primitiveFromSource(entry, matrix, style)
      if (!shape) return null
      usedKeys.add(name)
      return { ...shape, sourceKey: name }
    }

    const walk = (item: paper.Item | null, inherited: number): void => {
      const node = item as unknown as { visible?: boolean; isClipMask?: () => boolean; className: string }
      if (!item || node.visible === false || (typeof node.isClipMask === 'function' && node.isClipMask())) return
      const cls = item.className
      if (cls === 'Group' || cls === 'Layer') {
        const own = Number.isFinite((item as unknown as { opacity: number }).opacity)
          ? (item as unknown as { opacity: number }).opacity
          : 1
        for (const child of (item as paper.Group).children) walk(child, inherited * own)
        return
      }
      const style = readPaperStyle(item, inherited)
      if (style.fill?.gradient) warnings.gradients += 1
      if (cls === 'CompoundPath') {
        const fast = tryFast(item, style)
        if (fast) {
          shapes.push(fast)
          return
        }
        const commands = pathFromOriginalSource(item, prepared, usedKeys) ?? compoundToCommands(item)
        if (commands.length) shapes.push(makePathShape(item, style, commands))
        else warnings.skipped += 1
        return
      }
      if (cls === 'Path') {
        const fast = tryFast(item, style)
        if (fast) {
          shapes.push(fast)
          return
        }
        const commands = pathFromOriginalSource(item, prepared, usedKeys) ?? singlePathToCommands(item)
        if (commands.length) shapes.push(makePathShape(item, style, commands))
        else warnings.skipped += 1
        return
      }
      if (cls === 'Shape') {
        const fast = tryFast(item, style)
        if (fast) {
          shapes.push(fast)
          return
        }
        const asPath = (item as unknown as { toPath: (insert: boolean) => paper.Path }).toPath(false)
        const commands = asPath ? singlePathToCommands(asPath) : []
        if (commands.length) shapes.push(makePathShape(item, style, commands))
        else warnings.skipped += 1
        return
      }
      if (cls === 'Raster' || cls === 'PointText' || cls === 'SymbolItem') warnings.skipped += 1
    }

    if (imported) walk(imported, 1)
    outcome = {
      shapes,
      source: prepared.source,
      warnings,
      sourceDoc: prepared.sourceDoc,
      sourceRoot: prepared.sourceRoot,
      sourceElements: prepared.elements
    }
  } finally {
    paperScope.settings.scaleStrokes = prevScaleStrokes
    const node = imported as unknown as { isInserted?: () => boolean; remove?: () => void } | null
    if (node && typeof node.isInserted === 'function' && node.isInserted() && typeof node.remove === 'function') node.remove()
  }
  return outcome
}

/** 按 data-albedo-key 在来源 DOM 里找元素（值里的引号/反斜杠要先转义） */
export function findByAlbedoKey(root: Element, key: string): Element | null {
  const safe = String(key).replace(/(["\\])/g, '\\$1')
  return root.querySelector(`[data-albedo-key="${safe}"]`)
}

/** 元素祖先链上的 opacity 连乘（属性与 style 里的都算），遇到 svg 停 */
export function ancestorOpacityProduct(el: Element | null): number {
  let product = 1
  let cur = el?.parentElement ?? null
  while (cur && tagName(cur) !== 'svg') {
    const attr = cur.getAttribute('opacity')
    if (attr !== null && attr.trim() !== '') {
      const v = Number(attr)
      if (Number.isFinite(v)) product *= v
    }
    const style = cur.getAttribute('style') || ''
    const m = /(?:^|;)\s*opacity\s*:\s*([+-]?(?:\d+\.?\d*|\.\d+))(?=\s|;|$)/i.exec(style)
    if (m) product *= Number(m[1])
    cur = cur.parentElement
  }
  return Math.min(1, Math.max(0, product))
}
