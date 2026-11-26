import { ensurePaper, paperScope } from './paperRuntime.ts'

/**
 * 布尔运算：借 Paper.js 的 unite/subtract/intersect/exclude。
 *
 * 行为契约（与单文件版逐条对齐，界面上的说明文字就是按它写的）：
 *   按图层顺序从左到右折叠；开放路径**强制闭合**后按填充区域参与；描边宽度不扩张轮廓；
 *   结果只有直线与三次贝塞尔两种段，坐标 4 位小数；
 *   空结果（命令为空或面积 < 1e-6）返回 null，由调用方念"运算结果为空"。
 *
 * 值侧的 paperScope 只用来构造与折叠；类型走 paper.d.ts 的全局命名空间。
 */

export type BooleanKind = 'unite' | 'subtract' | 'intersect' | 'exclude'

export interface BooleanOperand {
  d: string
  fillRule: string
}

export interface BooleanSegment {
  type: 'M' | 'L' | 'C' | 'Z'
  x?: number
  y?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

export interface BooleanOutcome {
  segments: BooleanSegment[]
  fillRule: 'nonzero' | 'evenodd'
  area: number
}

/** 布尔结果的坐标口径：4 位小数，-0 归 0 */
function round4(v: number): number {
  const r = Math.round(Number(v) * 1e4) / 1e4
  return Object.is(r, -0) ? 0 : r
}

function toPaperItem(op: BooleanOperand): paper.PathItem {
  const d = String(op?.d || '').trim()
  if (!d || !/[Mm]/.test(d)) throw new Error('Empty path operand')
  const item: paper.PathItem =
    (d.match(/[Mm]/g) || []).length > 1
      ? new paperScope.CompoundPath(d)
      : new paperScope.Path(d)
  if ('fillRule' in item) item.fillRule = op.fillRule === 'evenodd' ? 'evenodd' : 'nonzero'
  const children = item.className === 'CompoundPath' ? (item as paper.CompoundPath).children : [item as paper.Path]
  children.forEach((child) => {
    if (child.className === 'Path') (child as paper.Path).closed = true
  })
  return item
}

function segmentToCommands(prev: paper.Segment, cur: paper.Segment, out: BooleanSegment[]): void {
  const handleOut = prev.handleOut
  const handleIn = cur.handleIn
  if (handleOut.length < 1e-7 && handleIn.length < 1e-7) {
    out.push({ type: 'L', x: round4(cur.point.x), y: round4(cur.point.y) })
    return
  }
  out.push({
    type: 'C',
    x1: round4(prev.point.x + handleOut.x),
    y1: round4(prev.point.y + handleOut.y),
    x2: round4(cur.point.x + handleIn.x),
    y2: round4(cur.point.y + handleIn.y),
    x: round4(cur.point.x),
    y: round4(cur.point.y)
  })
}

function pathToCommands(path: paper.Path, out: BooleanSegment[]): void {
  const segs = path.segments
  if (!segs || !segs.length) return
  out.push({ type: 'M', x: round4(segs[0]!.point.x), y: round4(segs[0]!.point.y) })
  for (let i = 0; i < segs.length - 1; i += 1) segmentToCommands(segs[i]!, segs[i + 1]!, out)
  if (path.closed) {
    const first = segs[0]!.point
    const last = segs[segs.length - 1]!.point
    const sameEnd = Math.abs(first.x - last.x) < 1e-7 && Math.abs(first.y - last.y) < 1e-7
    if (segs.length > 1 && !sameEnd) segmentToCommands(segs[segs.length - 1]!, segs[0]!, out)
    out.push({ type: 'Z' })
  }
}

function itemToCommands(item: paper.Item, out: BooleanSegment[]): void {
  if (!item) return
  if (item.className === 'CompoundPath') {
    ;(item as paper.CompoundPath).children.forEach((child) => itemToCommands(child, out))
    return
  }
  if (item.className === 'Path') pathToCommands(item as paper.Path, out)
}

/** 带符号面积合计 */
function signedAreaSum(item: paper.Item | null): number {
  if (!item) return 0
  if (item.className === 'CompoundPath') {
    return (item as paper.CompoundPath).children.reduce((sum, child) => sum + signedAreaSum(child), 0)
  }
  if (item.className === 'Path') return ((item as paper.Path).area as number) || 0
  return 0
}

/** 绝对面积合计（判空用的那把尺） */
function absAreaSum(item: paper.Item | null): number {
  if (!item) return 0
  if (item.className === 'CompoundPath') {
    return (item as paper.CompoundPath).children.reduce((sum, child) => sum + absAreaSum(child), 0)
  }
  if (item.className === 'Path') return Math.abs(((item as paper.Path).area as number) || 0)
  return 0
}

const OPS: Record<BooleanKind, (a: paper.PathItem, b: paper.PathItem) => paper.PathItem> = {
  unite: (a, b) => a.unite(b),
  subtract: (a, b) => a.subtract(b),
  intersect: (a, b) => a.intersect(b),
  exclude: (a, b) => a.exclude(b)
}

/**
 * 执行一次布尔折叠：ops 按图层顺序（先画的在左）。
 * 任何一步算不出东西返回 null；异常原样抛给调用方（它负责念"布尔运算失败：…"）。
 */
export function runBoolean(ops: BooleanOperand[], kind: BooleanKind): BooleanOutcome | null {
  const fn = OPS[kind]
  if (!fn) throw new Error(`Unknown boolean operation: ${String(kind)}`)
  if (!Array.isArray(ops) || ops.length < 2) throw new Error('Boolean operations need at least two operands')
  ensurePaper()
  const layer = paperScope.project.activeLayer
  layer.removeChildren()
  try {
    let result: paper.PathItem | null = toPaperItem(ops[0]!)
    for (let i = 1; i < ops.length && result; i += 1) {
      result = fn(result, toPaperItem(ops[i]!))
    }
    if (!result) return null
    const abs = absAreaSum(result)
    const signedAbs = Math.abs(signedAreaSum(result))
    const area = signedAbs > 1e-6 ? signedAbs : abs
    const segments: BooleanSegment[] = []
    itemToCommands(result, segments)
    if (segments.length === 0 || abs < 1e-6) return null
    return {
      segments,
      fillRule: result.fillRule === 'evenodd' ? 'evenodd' : 'nonzero',
      area
    }
  } finally {
    layer.removeChildren()
  }
}
