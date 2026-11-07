import type { PathCommand, Shape, ShapeBase } from './model.ts'

/**
 * 几何与序列化的纯函数层：数字口径、命令→d 串、形状→d 串、包围盒、
 * 平移/映射/重塑/拉手缩放、文字测量、缩放档位。全部无副作用（translateShape 除外，沿用原实现的就地修改）。
 */

/** 能拿到 opentype.Font 的鸭子切片：只有测量与描轮廓用到的那几个成员 */
export interface FontLike {
  unitsPerEm: number
  ascender: number
  descender: number
  getAdvanceWidth?: (text: string, size: number) => number
  getPath?: (text: string, x: number, y: number, size: number) => { commands: PaperishCommand[] }
}

interface PaperishCommand {
  type: string
  x?: number
  y?: number
  x1?: number
  y1?: number
  x2?: number
  y2?: number
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/* ---------------- 数字口径 ---------------- */

/** 主口径：四舍五入到 2 位小数转字符串；-0 写成 "0"（导出与输入框都念它） */
export function fmt(v: number, dp = 2): string {
  const j = 10 ** dp
  const n = Math.round(Number(v) * j) / j
  return Object.is(n, -0) ? '0' : String(n)
}

/** fmt 的 2 位口径速记（输入框值与坐标读数都走它） */
export function fmt2(v: number): string {
  return fmt(v, 2)
}

/** 布尔运算结果的口径：4 位小数，-0 归 0 */
export function fmt4(v: number): number {
  const n = Math.round(Number(v) * 1e4) / 1e4
  return Object.is(n, -0) ? 0 : n
}

/* ---------------- 命令 → d 串 ---------------- */

/** 命令数组 → SVG path d（每段以命令字母开头；坐标走 fmt，精度与 Qn 一样可传） */
export function commandsToPath(commands: PathCommand[], decimals = 2): string {
  const j = (v: number): string => fmt(v, decimals)
  return (Array.isArray(commands) ? commands : [])
    .map((c) => {
      switch (c.type) {
        case 'M':
          return `M ${j(c.x)} ${j(c.y)}`
        case 'L':
          return `L ${j(c.x)} ${j(c.y)}`
        case 'Q':
          return `Q ${j(c.x1)} ${j(c.y1)} ${j(c.x)} ${j(c.y)}`
        case 'C':
          return `C ${j(c.x1)} ${j(c.y1)} ${j(c.x2)} ${j(c.y2)} ${j(c.x)} ${j(c.y)}`
        case 'A':
          return (
            `A ${j(c.rx)} ${j(c.ry)} ${j(c.rotation)} ${c.largeArc ? 1 : 0} ${c.sweep ? 1 : 0} ` +
            `${j(c.x)} ${j(c.y)}`
          )
        case 'Z':
          return 'Z'
        default:
          return ''
      }
    })
    .filter(Boolean)
    .join(' ')
}

/** 矩形 → d 串：rx ≤ 1e-4 走 H/V 直角写法，否则四角圆弧（与单文件版 xf 逐字一致） */
export function rectToPath(s: { x: number; y: number; w: number; h: number; rx: number }): string {
  const x = Number(s.x) || 0
  const y = Number(s.y) || 0
  const w = Math.max(0, Number(s.w) || 0)
  const h = Math.max(0, Number(s.h) || 0)
  const rx = Math.min(Math.max(0, Number(s.rx) || 0), Math.min(w, h) / 2)
  if (rx <= 1e-4) {
    return `M ${fmt(x)} ${fmt(y)} H ${fmt(x + w)} V ${fmt(y + h)} H ${fmt(x)} Z`
  }
  return [
    `M ${fmt(x + rx)} ${fmt(y)}`,
    `H ${fmt(x + w - rx)}`,
    `A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + w)} ${fmt(y + rx)}`,
    `V ${fmt(y + h - rx)}`,
    `A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + w - rx)} ${fmt(y + h)}`,
    `H ${fmt(x + rx)}`,
    `A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x)} ${fmt(y + h - rx)}`,
    `V ${fmt(y + rx)}`,
    `A ${fmt(rx)} ${fmt(rx)} 0 0 1 ${fmt(x + rx)} ${fmt(y)}`,
    'Z'
  ].join(' ')
}

/** 椭圆/圆 → d 串：两段大弧（与 bf 一致） */
export function ellipseToPath(s: { cx: number; cy: number; r?: number; rx?: number; ry?: number; type: string }): string {
  const cx = Number(s.cx) || 0
  const cy = Number(s.cy) || 0
  if (s.type === 'circle') {
    const r = Math.max(0, Number(s.r) || 0)
    return (
      `M ${fmt(cx - r)} ${fmt(cy)} ` +
      `A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx + r)} ${fmt(cy)} ` +
      `A ${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(cx - r)} ${fmt(cy)} Z`
    )
  }
  const rx = Math.max(0, Number(s.rx) || 0)
  const ry = Math.max(0, Number(s.ry) || 0)
  return (
    `M ${fmt(cx - rx)} ${fmt(cy)} ` +
    `A ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx + rx)} ${fmt(cy)} ` +
    `A ${fmt(rx)} ${fmt(ry)} 0 1 0 ${fmt(cx - rx)} ${fmt(cy)} Z`
  )
}

/** 多边形 → d 串：首点 M，其余 L，闭合 Z */
export function polygonToPath(points: Array<{ x: number; y: number }>): string {
  const pts = Array.isArray(points) ? points : []
  if (!pts.length) return ''
  return `M ${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L ')} Z`
}

/** 有面积可描的形状才有 d；line 与 text 返回 null */
export function shapeToPathAttr(s: Shape): string | null {
  switch (s.type) {
    case 'rect':
      return rectToPath(s)
    case 'ellipse':
    case 'circle':
      return ellipseToPath(s)
    case 'polygon':
      return polygonToPath(s.points)
    case 'path':
      return commandsToPath(s.commands)
    default:
      return null
  }
}

/* ---------------- 命令链上的点 ---------------- */

export interface Point {
  x: number
  y: number
}

/** 逐条重放到第 index 条之前的当前点（Z 回到子路径起点） */
export function pointBefore(commands: PathCommand[], index = commands.length): Point | null {
  let cur: Point | null = null
  let start: Point | null = null
  for (let i = 0; i < index; i += 1) {
    const c = commands[i]!
    if (c.type === 'M') {
      cur = { x: c.x, y: c.y }
      start = cur
    } else if (c.type === 'L' || c.type === 'Q' || c.type === 'C' || c.type === 'A') {
      cur = { x: c.x, y: c.y }
    } else if (c.type === 'Z' && start) {
      cur = { ...start }
    }
  }
  return cur
}

/** 选中命令的回落：先找最后一条非 Z */
export function lastNonZCommand(path: { commands: PathCommand[] } | null): PathCommand | null {
  if (!path) return null
  for (let i = path.commands.length - 1; i >= 0; i -= 1) {
    if (path.commands[i]!.type !== 'Z') return path.commands[i]!
  }
  return null
}

/** 新选中 path 的高亮命令：第一个曲线命令，否则最后一条非 Z */
export function firstCurveOrLast(path: Shape | null): PathCommand | null {
  if (!path || path.type !== 'path') return null
  return path.commands.find((c) => c.type === 'C' || c.type === 'Q') ?? lastNonZCommand(path)
}

/** 命令的某个部位坐标：默认终点 */
export function cmdPoint(
  cmd: PathCommand,
  part: 'c1' | 'c2' | 'c' | 'end' = 'end'
): Point {
  if (cmd.type === 'Z' || cmd.type === 'M' || cmd.type === 'L') return { x: (cmd as { x: number }).x, y: (cmd as { y: number }).y }
  if (cmd.type === 'Q') {
    return part === 'c' || part === 'c1' ? { x: cmd.x1, y: cmd.y1 } : { x: cmd.x, y: cmd.y }
  }
  if (cmd.type === 'C') {
    if (part === 'c1') return { x: cmd.x1, y: cmd.y1 }
    if (part === 'c2') return { x: cmd.x2, y: cmd.y2 }
    return { x: cmd.x, y: cmd.y }
  }
  return { x: cmd.x, y: cmd.y }
}

/* ---------------- 曲线求值与极值 ---------------- */

export function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** 三次贝塞尔导数零点，只留 t∈(0,1) */
export function cubicExtremaT(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3)
  const b = 2 * (3 * p0 - 6 * p1 + 3 * p2)
  const c = -3 * p0 + 3 * p1
  const out: number[] = []
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) out.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const sq = Math.sqrt(disc)
      out.push((-b + sq) / (2 * a), (-b - sq) / (2 * a))
    }
  }
  return out.filter((t) => t > 0 && t < 1)
}

/* ---------------- 弧：端点参数 → 中心参数 ---------------- */

export interface ArcCenter {
  cx: number
  cy: number
  rx: number
  ry: number
  phi: number
  cos: number
  sin: number
  theta1: number
  delta: number
}

/** SVG 端点弧参数转中心参数；退化（半径 0 / 起终点重合）返回 null。含 radii 放大修正 */
export function arcToCenter(from: Point | null, cmd: PathCommand & { type: 'A' }): ArcCenter | null {
  const r = (v: number) => Number(fmt(v))
  const x1 = from ? r(from.x) : 0
  const y1 = from ? r(from.y) : 0
  const x2 = r(Number(cmd.x) || 0)
  const y2 = r(Number(cmd.y) || 0)
  const rx = Math.abs(r(Number(cmd.rx) || 0))
  const ry = Math.abs(r(Number(cmd.ry) || 0))
  if (!from || !(rx > 1e-6) || !(ry > 1e-6) || Math.hypot(x2 - x1, y2 - y1) < 1e-9) return null

  const phi = (r(Number(cmd.rotation) || 0) * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy

  let rxp = rx
  let ryp = ry
  const lambda = (x1p * x1p) / (rxp * rxp) + (y1p * y1p) / (ryp * ryp)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rxp *= s
    ryp *= s
  }

  const rx2 = rxp * rxp
  const ry2 = ryp * ryp
  const radiiSum = rx2 * y1p * y1p + ry2 * x1p * x1p
  if (!(radiiSum > 1e-12)) return null

  const large = cmd.largeArc ? 1 : 0
  const sweep = cmd.sweep ? 1 : 0
  const sign = large !== sweep ? 1 : -1
  const inner = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p
  const co = sign * Math.sqrt(Math.max(0, inner / radiiSum))
  const cxp = co * ((rxp * y1p) / ryp)
  const cyp = -co * ((ryp * x1p) / rxp)
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2

  const ux = (x1p - cxp) / rxp
  const uy = (y1p - cyp) / ryp
  const vx = (-x1p - cxp) / rxp
  const vy = (-y1p - cyp) / ryp
  const theta1 = Math.atan2(uy, ux)
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const TAU = Math.PI * 2
  if (!sweep && delta > 0) delta -= TAU
  if (sweep && delta < 0) delta += TAU

  return { cx, cy, rx: rxp, ry: ryp, phi, cos, sin, theta1, delta }
}

export function arcPointAt(c: ArcCenter, angle: number): Point {
  const co = Math.cos(angle)
  const si = Math.sin(angle)
  return {
    x: c.cx + c.rx * co * c.cos - c.ry * si * c.sin,
    y: c.cy + c.rx * si * c.sin + c.ry * co * c.cos
  }
}

export function arcContainsAngle(c: ArcCenter, angle: number): boolean {
  const TAU = Math.PI * 2
  let d = angle - c.theta1
  if (c.delta >= 0) {
    d = ((d % TAU) + TAU) % TAU
    return d <= c.delta + 1e-7
  }
  d = ((d % TAU) - TAU) % TAU
  return d >= c.delta - 1e-7
}

/** 把弧的四极角点与端点喂给 consume(x,y) */
export function arcExtrema(
  center: ArcCenter | null,
  from: Point,
  to: Point,
  consume: (x: number, y: number) => void
): void {
  consume(from.x, from.y)
  consume(to.x, to.y)
  if (!center) return
  const phi1 = Math.atan2(-center.ry * center.sin, center.rx * center.cos)
  const phi2 = Math.atan2(center.ry * center.cos, center.rx * center.sin)
  ;[phi1, phi1 + Math.PI, phi2, phi2 + Math.PI].forEach((a) => {
    if (!arcContainsAngle(center, a)) return
    const p = arcPointAt(center, a)
    consume(p.x, p.y)
  })
}

/* ---------------- 包围盒 ---------------- */

export interface TextFontLike {
  unitsPerEm: number
  ascender: number
  descender: number
  getAdvanceWidth?: (text: string, size: number) => number
}

/**
 * 文字测量：有 opentype 字体按字形度量；没有就按估测口径
 * （码点 > 11903 记一个字号宽、其余 0.55×，行高 1.2×，基线 0.9×）。
 */
export function textMeasure(text: string, fontSize: number, font: TextFontLike | null): {
  width: number
  height: number
  ascent: number
} {
  const s = String(text ?? '')
  if (font) {
    const scale = fontSize / (font.unitsPerEm || 1000)
    const ascent = (font.ascender || 0) * scale
    const descent = (font.descender || 0) * scale
    const adv = font.getAdvanceWidth ? font.getAdvanceWidth(s, fontSize) : 0
    return { width: Math.max(1, adv), height: Math.max(1, ascent - descent), ascent }
  }
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 11903 ? fontSize : fontSize * 0.55
  return { width: Math.max(1, w), height: fontSize * 1.2, ascent: fontSize * 0.9 }
}

/** 文字基线 y：y + ascent */
export function textBaselineY(s: { y: number; text: string; fontSize: number }, font: TextFontLike | null): number {
  return s.y + textMeasure(s.text, s.fontSize, font).ascent
}

/** 命令数组的紧包围盒：逐段重放 + 二次/三次极值 + 弧极值 */
export function pathCommandsBBox(commands: PathCommand[]): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let cur: Point | null = null
  let subpathStart: Point | null = null
  const add = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const c of commands) {
    if (c.type === 'M') {
      cur = { x: c.x, y: c.y }
      subpathStart = cur
      add(c.x, c.y)
    } else if (c.type === 'L') {
      add(c.x, c.y)
      cur = { x: c.x, y: c.y }
    } else if (c.type === 'Q' && cur) {
      const p0 = cur
      const p1 = { x: c.x1, y: c.y1 }
      const p2 = { x: c.x, y: c.y }
      const ts: number[] = []
      const ax = p0.x - 2 * p1.x + p2.x
      const bx = -2 * p0.x + 2 * p1.x
      const ay = p0.y - 2 * p1.y + p2.y
      const by = -2 * p0.y + 2 * p1.y
      if (Math.abs(ax) > 1e-9) ts.push(-bx / (2 * ax))
      if (Math.abs(ay) > 1e-9) ts.push(-by / (2 * ay))
      add(p2.x, p2.y)
      ts
        .filter((t) => t > 0 && t < 1)
        .forEach((t) => {
          const u = 1 - t
          add(u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y)
        })
      cur = p2
    } else if (c.type === 'C' && cur) {
      const p0 = cur
      const p1 = { x: c.x1, y: c.y1 }
      const p2 = { x: c.x2, y: c.y2 }
      const p3 = { x: c.x, y: c.y }
      add(p3.x, p3.y)
      ;[...cubicExtremaT(p0.x, p1.x, p2.x, p3.x), ...cubicExtremaT(p0.y, p1.y, p2.y, p3.y)].forEach((t) => {
        add(cubicAt(p0.x, p1.x, p2.x, p3.x, t), cubicAt(p0.y, p1.y, p2.y, p3.y, t))
      })
      cur = p3
    } else if (c.type === 'A' && cur) {
      const from = cur
      const to = { x: c.x, y: c.y }
      arcExtrema(arcToCenter(from, c), from, to, add)
      cur = to
    } else if (c.type === 'Z' && subpathStart) {
      cur = { ...subpathStart }
    }
  }
  return Number.isFinite(minX) ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 }
}

/** 形状包围盒（fontOf: fontFamily → opentype 字体或 null） */
export function shapeBBox(s: Shape | null, fontOf: (familyKey: string) => TextFontLike | null): Box {
  if (!s) return { x: 0, y: 0, w: 0, h: 0 }
  if (s.type === 'rect') return { x: s.x, y: s.y, w: s.w, h: s.h }
  if (s.type === 'ellipse') return { x: s.cx - s.rx, y: s.cy - s.ry, w: s.rx * 2, h: s.ry * 2 }
  if (s.type === 'circle') return { x: s.cx - s.r, y: s.cy - s.r, w: s.r * 2, h: s.r * 2 }
  if (s.type === 'polygon') {
    if (!Array.isArray(s.points) || !s.points.length) return { x: 0, y: 0, w: 0, h: 0 }
    const xs = s.points.map((p) => p.x)
    const ys = s.points.map((p) => p.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
  }
  if (s.type === 'line') {
    return {
      x: Math.min(s.x1, s.x2),
      y: Math.min(s.y1, s.y2),
      w: Math.abs(s.x2 - s.x1),
      h: Math.abs(s.y2 - s.y1)
    }
  }
  if (s.type === 'text') {
    const m = textMeasure(s.text, s.fontSize, fontOf(s.fontFamily))
    return { x: s.x, y: s.y, w: m.width, h: m.height }
  }
  if (s.type === 'path') return pathCommandsBBox(s.commands)
  return { x: 0, y: 0, w: 0, h: 0 }
}

/** 多个包围盒的并；空列表返回 null */
export function unionBoxes(boxes: Array<Box | null>): Box | null {
  const list = (Array.isArray(boxes) ? boxes : []).filter(Boolean) as Box[]
  if (!list.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of list) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/* ---------------- 平移 / 映射 / 重塑 ---------------- */

/** 就地平移一个形状（path 平移命令里所有坐标字段） */
export function translateShape(s: Shape, dx: number, dy: number): void {
  if (s.type === 'rect' || s.type === 'text') {
    s.x += dx
    s.y += dy
  } else if (s.type === 'ellipse' || s.type === 'circle') {
    s.cx += dx
    s.cy += dy
  } else if (s.type === 'polygon') {
    s.points.forEach((p) => {
      p.x += dx
      p.y += dy
    })
  } else if (s.type === 'line') {
    s.x1 += dx
    s.y1 += dy
    s.x2 += dx
    s.y2 += dy
  } else if (s.type === 'path') {
    for (const c of s.commands) {
      const cc = c as unknown as Record<string, number>
      for (const key of ['x', 'y', 'x1', 'y1', 'x2', 'y2']) {
        if (typeof cc[key] === 'number') cc[key] += key.startsWith('x') ? dx : dy
      }
    }
  }
}

/** 源包围盒 → 目标包围盒的线性映射；退化轴向取目标中心 */
export function mapPoint(x: number, y: number, src: Box, dst: Box): Point {
  const sx = src.w > 0.001 ? dst.w / src.w : 1
  const sy = src.h > 0.001 ? dst.h / src.h : 1
  return {
    x: src.w > 0.001 ? dst.x + (x - src.x) * sx : dst.x + dst.w / 2,
    y: src.h > 0.001 ? dst.y + (y - src.y) * sy : dst.y + dst.h / 2
  }
}

/** 非均匀缩放下 A 命令的再拟合：矩阵分解求新 rx/ry/rotation/largeArc，sweep 保持 */
export function mapArc(cmd: PathCommand & { type: 'A' }, from: Point, src: Box, dst: Box): {
  x: number
  y: number
  rx: number
  ry: number
  rotation: number
  largeArc: 0 | 1
  sweep: 0 | 1
} {
  const TAU = Math.PI * 2
  const sx = src.w > 0.001 ? dst.w / src.w : 1
  const sy = src.h > 0.001 ? dst.h / src.h : 1
  const end = mapPoint(cmd.x, cmd.y, src, dst)
  const center = arcToCenter(from, cmd)
  if (!center) {
    return {
      x: end.x,
      y: end.y,
      rx: Math.max(0.5, Math.abs(Number(cmd.rx) || 70) * Math.abs(sx)),
      ry: Math.max(0.5, Math.abs(Number(cmd.ry) || 50) * Math.abs(sy)),
      rotation: Number(cmd.rotation) || 0,
      largeArc: cmd.largeArc ? 1 : 0,
      sweep: cmd.sweep ? 1 : 0
    }
  }
  const start = mapPoint(from.x, from.y, src, dst)
  const gc = Math.cos(center.phi)
  const gs = Math.sin(center.phi)
  // 缩放矩阵 S ∘ R(phi) 分解成新的椭圆
  const a11 = sx * center.rx * gc
  const a12 = sy * center.rx * gs
  const a21 = -sx * center.ry * gs
  const a22 = sy * center.ry * gc
  const A = a11 * a11 + a21 * a21
  const B = a11 * a12 + a21 * a22
  const C = a12 * a12 + a22 * a22
  const sum = A + C
  const diff = Math.sqrt(Math.max(0, (A - C) * (A - C) + 4 * B * B))
  const rp = Math.max(0.5, Math.sqrt(Math.max(0, (sum + diff) / 2)))
  const rq = Math.max(0.5, Math.sqrt(Math.max(0, (sum - diff) / 2)))
  const theta = Math.abs(rp - rq) < 1e-6 ? 0 : 0.5 * Math.atan2(2 * B, A - C)
  const newCenter = mapPoint(center.cx, center.cy, src, dst)
  const angleOf = (p: Point): number => {
    const vx = p.x - newCenter.x
    const vy = p.y - newCenter.y
    const ct = Math.cos(theta)
    const st = Math.sin(theta)
    const rxv = ct * vx + st * vy
    const ryv = -st * vx + ct * vy
    return Math.atan2(ryv / rq, rxv / rp)
  }
  const t1 = angleOf(start)
  const t2 = angleOf(end)
  let delta: number
  if (cmd.sweep) delta = ((((t2 - t1) % TAU) + TAU) % TAU)
  else delta = -(((((t1 - t2) % TAU) + TAU) % TAU))
  return {
    x: end.x,
    y: end.y,
    rx: rp,
    ry: rq,
    rotation: Math.abs(theta) < 1e-9 ? 0 : (theta * 180) / Math.PI,
    largeArc: Math.abs(delta) > Math.PI + 1e-7 ? 1 : 0,
    sweep: cmd.sweep ? 1 : 0
  }
}

/** 把形状从 original 的 srcBox 整体重映射到 dstBox（就地写入 target） */
export function reshapeToBounds(target: Shape, original: Shape, src: Box, dst: Box): void {
  if (target.type === 'rect') {
    target.x = dst.x
    target.y = dst.y
    target.w = Math.max(1, dst.w)
    target.h = Math.max(1, dst.h)
  } else if (target.type === 'ellipse') {
    target.cx = dst.x + dst.w / 2
    target.cy = dst.y + dst.h / 2
    target.rx = Math.max(1, dst.w / 2)
    target.ry = Math.max(1, dst.h / 2)
  } else if (target.type === 'circle') {
    target.cx = dst.x + dst.w / 2
    target.cy = dst.y + dst.h / 2
    target.r = Math.max(1, Math.min(dst.w, dst.h) / 2)
  } else if (target.type === 'polygon' && original.type === 'polygon') {
    target.points = original.points.map((p) => mapPoint(p.x, p.y, src, dst))
  } else if (target.type === 'line' && original.type === 'line') {
    const a = mapPoint(original.x1, original.y1, src, dst)
    const b = mapPoint(original.x2, original.y2, src, dst)
    target.x1 = a.x
    target.y1 = a.y
    target.x2 = b.x
    target.y2 = b.y
  } else if (target.type === 'text' && original.type === 'text') {
    const scale = src.h > 0.001 ? dst.h / src.h : 1
    target.fontSize = Math.max(1, original.fontSize * scale)
    target.x = dst.x
    target.y = dst.y
  } else if (target.type === 'path' && original.type === 'path') {
    target.commands = original.commands.map((c, i) => {
      const copy = { ...c } as PathCommand
      if (c.type === 'M' || c.type === 'L') {
        const p = mapPoint(c.x, c.y, src, dst)
        ;(copy as MoveLike).x = p.x
        ;(copy as MoveLike).y = p.y
      } else if (c.type === 'Q') {
        const ctl = mapPoint(c.x1, c.y1, src, dst)
        const p = mapPoint(c.x, c.y, src, dst)
        const q = copy as QuadLike
        q.x1 = ctl.x
        q.y1 = ctl.y
        q.x = p.x
        q.y = p.y
      } else if (c.type === 'C') {
        const c1 = mapPoint(c.x1, c.y1, src, dst)
        const c2 = mapPoint(c.x2, c.y2, src, dst)
        const p = mapPoint(c.x, c.y, src, dst)
        const cc = copy as CubicLike
        cc.x1 = c1.x
        cc.y1 = c1.y
        cc.x2 = c2.x
        cc.y2 = c2.y
        cc.x = p.x
        cc.y = p.y
      } else if (c.type === 'A') {
        const from = pointBefore(original.commands, i)
        if (from) Object.assign(copy, mapArc(c, from, src, dst))
        else {
          const p = mapPoint(c.x, c.y, src, dst)
          const a = copy as ArcEndLike
          a.x = p.x
          a.y = p.y
        }
      }
      return copy
    })
  }
}

interface MoveLike {
  x: number
  y: number
}
interface QuadLike extends MoveLike {
  x1: number
  y1: number
}
interface CubicLike extends QuadLike {
  x2: number
  y2: number
}
interface ArcEndLike {
  x: number
  y: number
}

/** 8 向拉手拉伸：最小 3 用户单位；lockAspect 时按原宽高比修正另一边 */
export function resizeBounds(
  orig: Box,
  handles: string[],
  dx: number,
  dy: number,
  lockAspect: boolean
): Box {
  const r = { ...orig }
  let left = r.x
  let top = r.y
  let right = r.x + r.w
  let bottom = r.y + r.h
  const MIN = 3
  if (handles.includes('w')) left = Math.min(r.x + dx, right - MIN)
  if (handles.includes('e')) right = Math.max(r.x + r.w + dx, left + MIN)
  if (handles.includes('n')) top = Math.min(r.y + dy, bottom - MIN)
  if (handles.includes('s')) bottom = Math.max(r.y + r.h + dy, top + MIN)
  if (lockAspect && r.w > 0.001 && r.h > 0.001) {
    const ratio = r.w / r.h
    let w = right - left
    let h = bottom - top
    if (Math.abs(w / h) > ratio) {
      w = h * ratio
      if (handles.includes('w')) left = right - w
      else right = left + w
    } else {
      h = w / ratio
      if (handles.includes('n')) top = bottom - h
      else bottom = top + h
    }
  }
  return { x: left, y: top, w: right - left, h: bottom - top }
}

/* ---------------- 缩放档位 ---------------- */

const ZEPS = 1e-9
const LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6, 8]

export function clampZoom(v: unknown): number {
  const n = Number(v)
  return Number.isNaN(n) ? 1 : Math.min(8, Math.max(0.5, n))
}

/** 沿档位表步进：dir>0 取下一档，<0 取上一档，0 原样 */
export function stepZoom(current: unknown, dir: number): number {
  const z = clampZoom(current)
  if (dir > 0) return LEVELS.find((l) => l > z + ZEPS) ?? 8
  if (dir < 0) return [...LEVELS].reverse().find((l) => l < z - ZEPS) ?? 0.5
  return z
}

/** 滚轮增量 → 倍率（指数映射，钳 [0.5,2]）；0 或非法按 1 */
export function zoomFromWheel(delta: unknown): number {
  const n = Number(delta)
  if (!Number.isFinite(n) || n === 0) return 1
  return Math.min(2, Math.max(0.5, Math.exp(-n * 0.002)))
}

/** 缩放标签："125%" */
export function zoomLabel(v: unknown): string {
  return `${Math.round(clampZoom(v) * 100)}%`
}

/* ---------------- opentype → 命令 ---------------- */

/** opentype 字体 getPath 的 commands 转内部命令（带 id 由调用方补） */
export function fontPathCommands(font: { getPath: FontLike['getPath'] }, text: string, x: number, y: number, size: number): Array<{ type: 'M' | 'L' | 'Q' | 'C' | 'Z'; x?: number; y?: number; x1?: number; y1?: number; x2?: number; y2?: number }> {
  const path = font.getPath?.(String(text ?? ''), x, y, size)
  return (Array.isArray(path?.commands) ? path.commands : [])
    .map((m) =>
      m.type === 'M' || m.type === 'L'
        ? { type: m.type as 'M' | 'L', x: m.x, y: m.y }
        : m.type === 'Q'
          ? { type: 'Q' as const, x1: m.x1, y1: m.y1, x: m.x, y: m.y }
          : m.type === 'C'
            ? { type: 'C' as const, x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, x: m.x, y: m.y }
            : m.type === 'Z'
              ? { type: 'Z' as const }
              : null
    )
    .filter((v): v is NonNullable<typeof v> => v !== null)
}
