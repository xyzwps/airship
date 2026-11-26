import type { PathCommand } from './model.ts'

/**
 * 2D 仿射矩阵与 SVG transform 属性——导入解析、导出补丁、弧变换共用的一层。
 * 行向量约定：`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。
 */

export interface Matrix {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

export function identity(): Matrix {
  return { ...IDENTITY }
}

/** A 后接 B（从左到右右乘，与 SVG 规范的 transform 列表语义一致） */
export function multiply(A: Matrix, B: Matrix): Matrix {
  return {
    a: A.a * B.a + A.c * B.b,
    b: A.b * B.a + A.d * B.b,
    c: A.a * B.c + A.c * B.d,
    d: A.b * B.c + A.d * B.d,
    e: A.a * B.e + A.c * B.f + A.e,
    f: A.b * B.e + A.d * B.f + A.f
  }
}

export function applyMatrix(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

/** 行列式绝对值 ≤ 1e-9 视为不可逆，返回 null */
export function invertMatrix(m: Matrix): Matrix | null {
  const a = Number(m.a) || 0
  const b = Number(m.b) || 0
  const c = Number(m.c) || 0
  const d = Number(m.d) || 0
  const e = Number(m.e) || 0
  const f = Number(m.f) || 0
  const det = a * d - b * c
  if (Math.abs(det) <= 1e-9) return null
  return { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det }
}

export function isIdentityMatrix(m: Matrix | null): boolean {
  if (!m) return false
  return (
    Math.abs(m.a - 1) < 1e-9 &&
    Math.abs(m.b) < 1e-9 &&
    Math.abs(m.c) < 1e-9 &&
    Math.abs(m.d - 1) < 1e-9 &&
    Math.abs(m.e) < 1e-9 &&
    Math.abs(m.f) < 1e-9
  )
}

/** 导出补丁用：matrix(a b c d e f)，每分量 toFixed(9) 去尾零 */
export function matrixToSvgTransform(m: Matrix): string {
  const parts = [m.a, m.b, m.c, m.d, m.e, m.f].map((v) => Number(v.toFixed(9)))
  return `matrix(${parts.join(' ')})`
}

/**
 * transform 属性解析：只认 matrix/translate/scale/rotate/skewX/skewY 六个精确拼写；
 * 任何一段不合（参数个数不对、非数字、函数间隙有杂字、一个都没匹配上）整体判 null。
 */
export function parseTransformAttr(raw: string | null | undefined): Matrix | null {
  const s = String(raw || '').trim()
  if (!s) return identity()
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g
  let acc = identity()
  let lastIndex = 0
  let hit: RegExpExecArray | null
  while ((hit = re.exec(s)) !== null) {
    if (!/^[\s,]*$/.test(s.slice(lastIndex, hit.index))) return null
    lastIndex = re.lastIndex
    const name = hit[1]!
    const args = hit[2]!.trim() ? hit[2]!.trim().split(/[\s,]+/).map(Number) : []
    if (!args.every(Number.isFinite)) return null
    let m: Matrix | null = null
    if (name === 'matrix' && args.length === 6) {
      m = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! }
    } else if (name === 'translate' && (args.length === 1 || args.length === 2)) {
      m = { a: 1, b: 0, c: 0, d: 1, e: args[0]!, f: args[1] || 0 }
    } else if (name === 'scale' && (args.length === 1 || args.length === 2)) {
      m = { a: args[0]!, b: 0, c: 0, d: args.length === 1 ? args[0]! : args[1]!, e: 0, f: 0 }
    } else if (name === 'rotate' && (args.length === 1 || args.length === 3)) {
      const rad = (args[0]! * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      m = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
      if (args.length === 3) {
        m = multiply(
          multiply({ a: 1, b: 0, c: 0, d: 1, e: args[1]!, f: args[2]! }, m),
          { a: 1, b: 0, c: 0, d: 1, e: -args[1]!, f: -args[2]! }
        )
      }
    } else if (name === 'skewX' && args.length === 1) {
      m = { a: 1, b: 0, c: Math.tan((args[0]! * Math.PI) / 180), d: 1, e: 0, f: 0 }
    } else if (name === 'skewY' && args.length === 1) {
      m = { a: 1, b: Math.tan((args[0]! * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 }
    }
    if (!m) return null
    acc = multiply(acc, m)
  }
  if (lastIndex === 0 || !/^[\s,]*$/.test(s.slice(lastIndex))) return null
  return acc
}

/**
 * viewBox → 输出视口的适配矩阵（preserveAspectRatio 全语义：meet/slice、
 * xMin/xMid/xMax、YMin/YMid/YMax、defer 前缀、none 非等比）。
 */
export function viewBoxToFit(
  viewBox: number[] | null,
  outW: number | null,
  outH: number | null,
  preserveAspectRatio: string | null | undefined
): Matrix {
  if (!Array.isArray(viewBox) || viewBox.length !== 4) return identity()
  const [minX, minY, vbW, vbH] = viewBox
  if (![minX, minY, vbW, vbH].every((v) => Number.isFinite(v)) || !(vbW! > 0) || !(vbH! > 0)) return identity()
  const w = Number.isFinite(outW) && (outW as number) > 0 ? (outW as number) : vbW!
  const h = Number.isFinite(outH) && (outH as number) > 0 ? (outH as number) : vbH!
  const words = String(preserveAspectRatio || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  let align = words[0] || 'xMidYMid'
  if (align === 'defer') align = words[1] || 'xMidYMid'
  const slice = words.includes('slice')

  if (align === 'none') {
    const sx = w / vbW!
    const sy = h / vbH!
    const e = -minX! * sx
    const f = -minY! * sy
    return { a: sx, b: 0, c: 0, d: sy, e: e === 0 ? 0 : e, f: f === 0 ? 0 : f }
  }
  const scale = slice ? Math.max(w / vbW!, h / vbH!) : Math.min(w / vbW!, h / vbH!)
  const xAlign = align.startsWith('xMax') ? 1 : align.startsWith('xMid') ? 0.5 : 0
  const yAlign = align.includes('YMax') ? 1 : align.includes('YMid') ? 0.5 : 0
  const e = (w - vbW! * scale) * xAlign - minX! * scale
  const f = (h - vbH! * scale) * yAlign - minY! * scale
  return { a: scale, b: 0, c: 0, d: scale, e: e === 0 ? 0 : e, f: f === 0 ? 0 : f }
}

/** 弧旋转折叠回 (-90°, 90°]：半周期等价 */
export function normalizeAngle180(deg: number): number {
  let o = deg % 180
  if (o < 0) o += 180
  if (o > 90) o -= 180
  return Math.abs(o) < 1e-9 ? 0 : o
}

export interface ArcParams {
  rx: number
  ry: number
  rotation: number
  largeArc: 0 | 1
  sweep: 0 | 1
}

function flipSweep(sweep: 0 | 1, reflect: boolean): 0 | 1 {
  return reflect ? ((1 - sweep) as 0 | 1) : sweep
}

/** 把一条 A 命令的弧参数搬过任意可逆矩阵：等比/旋转分支走角度修正，一般分支走特征值分解 */
export function transformArc(arc: ArcParams, m: Matrix): ArcParams | null {
  const rx = Math.abs(Number(arc.rx) || 0)
  const ry = Math.abs(Number(arc.ry) || 0)
  if (!(rx > 1e-9) || !(ry > 1e-9)) return null
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) <= 1e-9) return null
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  const dot = m.a * m.c + m.b * m.d
  const eps = 1e-9 * Math.max(1, sx * sy)

  if (Math.abs(sx - sy) <= eps && Math.abs(dot) <= eps) {
    // 纯旋转/反射/均匀缩放
    const scale = (sx + sy) / 2
    const theta = (Math.atan2(m.b, m.a) * 180) / Math.PI
    const orig = Number(arc.rotation) || 0
    const rot = det < 0 ? theta - orig : theta + orig
    return {
      rx: rx * scale,
      ry: ry * scale,
      rotation: normalizeAngle180(rot),
      largeArc: arc.largeArc,
      sweep: flipSweep(arc.sweep, det < 0)
    }
  }
  const cos = Math.cos(((Number(arc.rotation) || 0) * Math.PI) / 180)
  const sin = Math.sin(((Number(arc.rotation) || 0) * Math.PI) / 180)
  const p1x = (m.a * cos + m.c * sin) * rx
  const p1y = (m.b * cos + m.d * sin) * rx
  const q1x = (-m.a * sin + m.c * cos) * ry
  const q1y = (-m.b * sin + m.d * cos) * ry
  const A = p1x * p1x + q1x * q1x
  const B = p1x * p1y + q1x * q1y
  const C = p1y * p1y + q1y * q1y
  const tr = A + C
  const dif = A - C
  const root = Math.hypot(dif, 2 * B)
  const l1 = (tr + root) / 2
  const l2 = (tr - root) / 2
  if (!(l1 > 1e-9) || !(l2 > 1e-9)) return null
  return {
    rx: Math.sqrt(l1),
    ry: Math.sqrt(l2),
    rotation: l1 - l2 < 1e-9 * l1 ? 0 : normalizeAngle180((0.5 * Math.atan2(2 * B, dif) * 180) / Math.PI),
    largeArc: arc.largeArc,
    sweep: flipSweep(arc.sweep, det < 0)
  }
}

/**
 * 矩阵逐条作用到命令数组（维护子路径起点；零长弧丢弃、不可逆变换的弧降级成 L）。
 * 输出坐标不做舍入。
 */
export function transformCommands(commands: PathCommand[], matrix?: Matrix | null): PathCommand[] {
  const m = matrix ? { ...matrix } : identity()
  const list = Array.isArray(commands) ? commands : []
  const out: PathCommand[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  for (const cmd of list) {
    if (!cmd || !(cmd as { type?: string }).type) continue
    if (cmd.type === 'Z') {
      out.push({ ...cmd })
      cx = sx
      cy = sy
      continue
    }
    if (cmd.type === 'A') {
      const end = applyMatrix(m, cmd.x, cmd.y)
      if (Math.hypot(end.x - cx, end.y - cy) < 1e-9) continue
      const arc = transformArc(cmd, m)
      if (arc) {
        out.push({ ...cmd, ...arc, x: end.x, y: end.y } as PathCommand)
      } else {
        out.push({ id: cmd.id, type: 'L', x: end.x, y: end.y })
      }
      cx = end.x
      cy = end.y
      continue
    }
    if (cmd.type === 'M' || cmd.type === 'L') {
      const p = applyMatrix(m, cmd.x, cmd.y)
      out.push({ ...cmd, x: p.x, y: p.y } as PathCommand)
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
      out.push({ ...cmd, x1: c1.x, y1: c1.y, x: p.x, y: p.y } as PathCommand)
      cx = p.x
      cy = p.y
      continue
    }
    if (cmd.type === 'C') {
      const c1 = applyMatrix(m, cmd.x1, cmd.y1)
      const c2 = applyMatrix(m, cmd.x2, cmd.y2)
      const p = applyMatrix(m, cmd.x, cmd.y)
      out.push({ ...cmd, x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y } as PathCommand)
      cx = p.x
      cy = p.y
    }
  }
  return out
}
