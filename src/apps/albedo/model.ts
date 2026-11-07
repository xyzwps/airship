import { t, type Lang } from './i18n.ts'

/**
 * Albedo 的数据模型：形状、路径命令、文档，以及**唯一的净化入口** `normalizeDoc`。
 *
 * 净化是所有入口共用的那一道——读档、撤销栈恢复、导入回落——畸形数据在这里被
 * 修成可画的或整条丢掉，渲染层因此永远拿到合法值。数字默认值与钳制范围
 * 全部沿用单文件版（那是行为，不是随手写的）。
 */

/* ---------------- 路径命令 ---------------- */

export type CommandType = 'M' | 'L' | 'Q' | 'C' | 'A' | 'Z'

export interface MoveCommand {
  id: string
  type: 'M'
  x: number
  y: number
}
export interface LineCommand {
  id: string
  type: 'L'
  x: number
  y: number
}
export interface QuadCommand {
  id: string
  type: 'Q'
  x1: number
  y1: number
  x: number
  y: number
}
export interface CubicCommand {
  id: string
  type: 'C'
  x1: number
  y1: number
  x2: number
  y2: number
  x: number
  y: number
}
export interface ArcCommand {
  id: string
  type: 'A'
  rx: number
  ry: number
  rotation: number
  largeArc: 0 | 1
  sweep: 0 | 1
  x: number
  y: number
}
export interface CloseCommand {
  id: string
  type: 'Z'
}

export type PathCommand =
  | MoveCommand
  | LineCommand
  | QuadCommand
  | CubicCommand
  | ArcCommand
  | CloseCommand

export const COMMAND_TYPES: CommandType[] = ['M', 'L', 'Q', 'C', 'A', 'Z']

/**
 * 还没补 id 的命令（解析 d 串、paper 转换、导入快路都产出它）；
 * normalizeCommands 是它变成 PathCommand 的唯一通道。
 */
export type LoosePathCommand =
  | { type: 'M' | 'L'; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'A'; rx: number; ry: number; rotation: number; largeArc: 0 | 1; sweep: 0 | 1; x: number; y: number }
  | { type: 'Z' }

/* ---------------- 形状 ---------------- */

export type ShapeType = 'rect' | 'ellipse' | 'circle' | 'polygon' | 'line' | 'text' | 'path'

export interface ShapeBase {
  id: string
  name: string
  /** 6 位 hex 或 "none"；line 恒为 "none" */
  fill: string
  /** 6 位 hex 或 "none" */
  stroke: string
  /** [0,120] */
  strokeWidth: number
  /** [0,1] */
  opacity: number
  fillRule: 'nonzero' | 'evenodd'
  /** false = 画布上不画、点不着，只用来描图时清场；照样进文档数据、进导出、进 PNG */
  visible: boolean
}

export interface RectShape extends ShapeBase {
  type: 'rect'
  x: number
  y: number
  w: number
  h: number
  /** 圆角半径，钳 [0,1e4]，画的时候再钳到 min(w,h)/2 */
  rx: number
}
export interface EllipseShape extends ShapeBase {
  type: 'ellipse'
  cx: number
  cy: number
  rx: number
  ry: number
}
export interface CircleShape extends ShapeBase {
  type: 'circle'
  cx: number
  cy: number
  r: number
}
export interface PolygonShape extends ShapeBase {
  type: 'polygon'
  /** 3–24 个顶点 */
  points: Array<{ x: number; y: number }>
}
export interface LineShape extends ShapeBase {
  type: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
}
export interface TextShape extends ShapeBase {
  type: 'text'
  x: number
  y: number
  text: string
  /** 字体的 postscriptName；空串 = 还没选字体 */
  fontFamily: string
  /** 界面上念给人看的 "Family Style" */
  fontDisplay: string
  /** [1,5000] */
  fontSize: number
}
export interface PathShape extends ShapeBase {
  type: 'path'
  commands: PathCommand[]
}

export type Shape =
  | RectShape
  | EllipseShape
  | CircleShape
  | PolygonShape
  | LineShape
  | TextShape
  | PathShape

/* ---------------- 文档与桌布 ---------------- */

export interface Doc {
  /** "none" 或 6 位 hex：画布视图背景，不进导出 */
  background: string
  /** [64,10000]，整数 */
  width: number
  height: number
  shapes: Shape[]
}

export interface Underlay {
  name: string
  /** data:image/… */
  src: string
  x: number
  y: number
  w: number
  h: number
  naturalW: number
  naturalH: number
  /** [0.05,1] */
  opacity: number
  visible: boolean
}

/* ---------------- 常数（行为，不是审美） ---------------- */

export const GRID_SIZES = [1, 2, 4, 8, 16, 32] as const
export const PALETTE = ['#f2c75c', '#f26b4f', '#7bb6a4', '#98a6e8', '#e9a4b8', '#cfd8a6'] as const
export const ZOOM_LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8] as const
/** 撤销栈上限 */
export const HISTORY_LIMIT = 70
/** 连续输入的合并窗口（ms） */
export const EDIT_MERGE_MS = 650
/** 自动保存防抖（ms）与桌布保存防抖（ms） */
export const SAVE_DEBOUNCE_MS = 320
export const UNDERLAY_SAVE_DEBOUNCE_MS = 420
/** 桌布 dataURL 落盘的两个"较大"阈值（字符数，不是字节数） */
export const UNDERLAY_SRC_MAX = 3_199_000
export const UNDERLAY_JSON_MAX = 3_200_000
/** 最近字体上限 */
export const RECENT_FONTS_MAX = 8

export const SHAPE_TYPES: ShapeType[] = ['rect', 'ellipse', 'circle', 'polygon', 'line', 'text', 'path']

/** 插入栏的快捷键（注意椭圆是 O，命令行的 E 是另一套） */
export const SHAPE_HOTKEYS: Record<ShapeType, string> = {
  rect: 'R',
  ellipse: 'O',
  circle: 'C',
  polygon: 'G',
  line: 'L',
  text: 'T',
  path: 'P'
}

/* ---------------- id ---------------- */

let idCounter = 0
/** 与单文件版同形状："s_<base36 时间>_<base36 自增>"；命令用 "c" 前缀 */
export function makeId(prefix = 's'): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`
}

/* ---------------- 数值与净化 ---------------- */

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

/** 有限数才收，否则用默认值（与单文件版 Je 一致） */
function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 默认名："矩形 2"；调用方负责它是"此刻语言的默认名"（切语言时由 localizeDoc 识别改写） */
export function defaultShapeName(lang: Lang, type: ShapeType, index: number): string {
  return `${t(lang, `name.${type}`)} ${index}`
}

export function regularPolygonPoints(
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  startAngle = -Math.PI / 2
): Array<{ x: number; y: number }> {
  const n = Number.isFinite(Number(sides)) ? clamp(Math.round(Number(sides)), 3, 24) : 5
  const r = Number.isFinite(Number(radius)) ? Math.max(1, Number(radius)) : 60
  const a0 = Number.isFinite(Number(startAngle)) ? Number(startAngle) : -Math.PI / 2
  return Array.from({ length: n }, (_, k) => {
    const angle = a0 + (k * Math.PI * 2) / n
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r }
  })
}

/** 顶点净化：最多 24 个，滤非法，少于 3 个算没有 */
export function normalizePoints(raw: unknown): Array<{ x: number; y: number }> | null {
  if (!Array.isArray(raw)) return null
  const pts: Array<{ x: number; y: number }> = []
  for (const item of raw.slice(0, 24)) {
    if (!item) continue
    const x = num(item.x, NaN)
    const y = num(item.y, NaN)
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push({ x, y })
  }
  return pts.length >= 3 ? pts : null
}

/** 点集的等权中心与平均半径（多边形按中心重生成时用） */
export function pointCloudFit(points: Array<{ x: number; y: number }>): {
  cx: number
  cy: number
  radius: number
  startAngle: number
} {
  if (!Array.isArray(points) || points.length === 0) {
    return { cx: 0, cy: 0, radius: 60, startAngle: -Math.PI / 2 }
  }
  const cx = points.reduce((s, p) => s + p.x, 0) / points.length
  const cy = points.reduce((s, p) => s + p.y, 0) / points.length
  const mean = points.reduce((s, p) => s + Math.hypot(p.x - cx, p.y - cy), 0) / points.length
  const first = points[0]!
  return {
    cx,
    cy,
    radius: Number.isFinite(mean) ? Math.max(8, mean) : 60,
    startAngle: Math.atan2(first.y - cy, first.x - cx)
  }
}

/** 命令净化：类型表外的整条丢弃，字段按默认值修好 */
export function normalizeCommands(raw: unknown): PathCommand[] {
  const list = Array.isArray(raw) ? raw : []
  const out: PathCommand[] = []
  for (const item of list) {
    if (!item || !COMMAND_TYPES.includes(item.type)) continue
    const id = typeof item.id === 'string' && item.id ? item.id : makeId('c')
    switch (item.type as CommandType) {
      case 'M':
      case 'L':
        out.push({ id, type: item.type, x: num(item.x, 200), y: num(item.y, 200) })
        break
      case 'Q':
        out.push({
          id,
          type: 'Q',
          x1: num(item.x1, 250),
          y1: num(item.y1, 150),
          x: num(item.x, 320),
          y: num(item.y, 220)
        })
        break
      case 'C':
        out.push({
          id,
          type: 'C',
          x1: num(item.x1, 260),
          y1: num(item.y1, 120),
          x2: num(item.x2, 420),
          y2: num(item.y2, 260),
          x: num(item.x, 480),
          y: num(item.y, 180)
        })
        break
      case 'A':
        out.push({
          id,
          type: 'A',
          rx: Math.max(0.5, Math.abs(num(item.rx, 70))),
          ry: Math.max(0.5, Math.abs(num(item.ry, 50))),
          rotation: num(item.rotation, 0),
          largeArc: num(item.largeArc, 0) ? 1 : 0,
          sweep: num(item.sweep, 0) ? 1 : 0,
          x: num(item.x, 520),
          y: num(item.y, 240)
        })
        break
      case 'Z':
        out.push({ id, type: 'Z' })
        break
    }
  }
  return out
}

/**
 * 唯一文档净化器（对应单文件版 wi）。默认位置类字段以文档宽高为参照，
 * 所以宽高先修、形状后修。画布没有名字：文档里不存在 name 这个字段，
 * 旧存档里残留的 name 读到时直接忽略，不迁移。
 */
export function normalizeDoc(raw: unknown, lang: Lang): Doc {
  const input = (raw ?? {}) as Record<string, unknown>
  const doc: Doc = {
    background: input.background === 'none' || isHexColor(input.background) ? input.background : '#fffdf8',
    width: clamp(Math.round(num(input.width, 960)), 64, 10000),
    height: clamp(Math.round(num(input.height, 640)), 64, 10000),
    shapes: []
  }
  const shapes = Array.isArray(input.shapes) ? input.shapes : []
  for (const item of shapes) {
    if (!item || !SHAPE_TYPES.includes(item.type)) continue
    const type = item.type as ShapeType
    const base: ShapeBase = {
      id: typeof item.id === 'string' && item.id ? item.id : makeId('s'),
      name: typeof item.name === 'string' && item.name ? item.name : defaultShapeName(lang, type, doc.shapes.length + 1),
      fill: type === 'line' ? 'none' : isHexColor(item.fill) || item.fill === 'none' ? item.fill : '#f2c75c',
      stroke: isHexColor(item.stroke) || item.stroke === 'none' ? item.stroke : '#1b1d22',
      strokeWidth: Number.isFinite(Number(item.strokeWidth)) ? clamp(Number(item.strokeWidth), 0, 120) : 2,
      opacity: Number.isFinite(Number(item.opacity)) ? clamp(Number(item.opacity), 0, 1) : 1,
      fillRule: type === 'path' && item.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
      visible: item.visible !== false
    }
    switch (type) {
      case 'rect':
        doc.shapes.push({
          ...base,
          type: 'rect',
          x: num(item.x, 360),
          y: num(item.y, 240),
          w: Math.max(1, num(item.w, 240)),
          h: Math.max(1, num(item.h, 160)),
          rx: clamp(num(item.rx, 0), 0, 1e4)
        })
        break
      case 'ellipse':
        doc.shapes.push({
          ...base,
          type: 'ellipse',
          cx: num(item.cx, 480),
          cy: num(item.cy, 320),
          rx: Math.max(1, num(item.rx, 130)),
          ry: Math.max(1, num(item.ry, 100))
        })
        break
      case 'circle':
        doc.shapes.push({
          ...base,
          type: 'circle',
          cx: num(item.cx, doc.width / 2),
          cy: num(item.cy, doc.height / 2),
          r: Math.max(1, num(item.r, Math.min(doc.width, doc.height) * 0.18))
        })
        break
      case 'polygon':
        doc.shapes.push({
          ...base,
          type: 'polygon',
          points:
            normalizePoints(item.points) ??
            regularPolygonPoints(doc.width / 2, doc.height / 2, Math.min(doc.width, doc.height) * 0.22, 5)
        })
        break
      case 'line':
        doc.shapes.push({
          ...base,
          type: 'line',
          x1: num(item.x1, 300),
          y1: num(item.y1, 380),
          x2: num(item.x2, 660),
          y2: num(item.y2, 260)
        })
        break
      case 'text':
        doc.shapes.push({
          ...base,
          type: 'text',
          x: num(item.x, doc.width * 0.25),
          y: num(item.y, doc.height * 0.4),
          text: typeof item.text === 'string' ? item.text : '',
          fontFamily: typeof item.fontFamily === 'string' ? item.fontFamily : '',
          fontDisplay: typeof item.fontDisplay === 'string' ? item.fontDisplay : '',
          fontSize: clamp(num(item.fontSize, 64), 1, 5000)
        })
        break
      case 'path':
        doc.shapes.push({ ...base, type: 'path', commands: normalizeCommands(item.commands) })
        break
    }
  }
  return doc
}

/** 新建空白文档（"新建"按钮与首启都走这里；背景与尺寸沿用默认纸色 960×640） */
export function makeBlankDoc(lang: Lang): Doc {
  return normalizeDoc({}, lang)
}

/** 示例文档（首启 starter）：椭圆 + 圆角矩形 + 三次贝塞尔，坐标与配色逐字沿用单文件版 di */
export function makeStarterDoc(lang: Lang): Doc {
  const doc = normalizeDoc({}, lang)
  doc.shapes = [
    {
      id: makeId('s'),
      type: 'ellipse',
      name: `${t(lang, 'name.ellipse')} 1`,
      fill: '#f26b4f',
      stroke: '#1b1d22',
      strokeWidth: 2,
      opacity: 1,
      fillRule: 'nonzero',
      visible: true,
      cx: 612,
      cy: 322,
      rx: 171,
      ry: 171
    },
    {
      id: makeId('s'),
      type: 'rect',
      name: `${t(lang, 'name.roundedRect')} 1`,
      fill: '#f2c75c',
      stroke: '#1b1d22',
      strokeWidth: 2,
      opacity: 1,
      fillRule: 'nonzero',
      visible: true,
      x: 150,
      y: 180,
      w: 304,
      h: 304,
      rx: 68
    },
    {
      id: makeId('s'),
      type: 'path',
      name: `${t(lang, 'name.bezierCurve')} 1`,
      fill: 'none',
      stroke: '#171a1f',
      strokeWidth: 6,
      opacity: 1,
      fillRule: 'nonzero',
      visible: true,
      commands: [
        { id: makeId('c'), type: 'M', x: 242, y: 438 },
        { id: makeId('c'), type: 'C', x1: 335, y1: 216, x2: 504, y2: 519, x: 652, y: 318 },
        { id: makeId('c'), type: 'C', x1: 731, y1: 219, x2: 820, y2: 276, x: 842, y: 409 }
      ]
    }
  ]
  return doc
}

/** 桌布净化（读档与导入共用）：src 必须是 data:image/…，宽高 ≤0 整体作废 */
export function normalizeUnderlay(raw: unknown, lang: Lang): Underlay | null {
  if (!raw || typeof raw !== 'object') return null
  const input = raw as Record<string, unknown>
  if (typeof input.src !== 'string' || !/^data:image\//i.test(input.src)) return null
  const w = num(input.w, 0)
  const h = num(input.h, 0)
  if (!(w > 0) || !(h > 0)) return null
  return {
    name: typeof input.name === 'string' && input.name ? input.name : t(lang, 'underlay.defaultName'),
    src: input.src,
    x: num(input.x, 0),
    y: num(input.y, 0),
    w: Math.max(8, w),
    h: Math.max(8, h),
    naturalW: Math.max(1, num(input.naturalW, w)),
    naturalH: Math.max(1, num(input.naturalH, h)),
    opacity: clamp(num(input.opacity, 0.85), 0.05, 1),
    visible: input.visible !== false
  }
}

/** polygon 的 points 属性串："x,y x,y …"（两位小数，Oe 的口径由 geom.fmt 提供） */
export function pointsAttr(
  points: Array<{ x: number; y: number }>,
  fmtNumber: (n: number) => string
): string {
  return (Array.isArray(points) ? points : []).map((p) => `${fmtNumber(p.x)},${fmtNumber(p.y)}`).join(' ')
}
