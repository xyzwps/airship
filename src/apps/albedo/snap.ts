import type { Box } from './geom.ts'

/**
 * 吸附：候选线来自其他形状与画布的边/中心（kind "shape"）、参与拖动自身的节点（kind "node"）、
 * 网格（kind "grid"）。优先级 shape > node > grid——同距离时先形状后网格。
 * 阈值由调用方按屏幕像素换算成用户单位传入（enabled 关或阈值 ≤0 就原样返回）。
 */

export type SnapKind = 'shape' | 'node' | 'grid'

export interface SnapCandidateSource {
  x: number
  y: number
  w: number
  h: number
}

export interface SnapOptions {
  enabled: boolean
  threshold: number
  grid: { enabled?: boolean; size: number }
  /** 其他形状与画布的包围盒（不含正在拖动的） */
  targets: SnapCandidateSource[]
  /** 参与拖动的形状自身的顶点（node 级候选） */
  points?: Array<{ x: number; y: number } | null>
  /** 画布本体：0、宽/2、宽（或高）三根 shape 级候选线 */
  artboard?: { w: number; h: number } | null
}

export interface SnapGuide {
  axis: 'x' | 'y'
  value: number
  kind: SnapKind
}

interface SnapHit {
  delta: number
  value: number
  kind: SnapKind
  distance: number
}

const KIND_PRIORITY: Record<SnapKind, number> = { shape: 3, node: 2, grid: 1 }

/** 一根轴上的候选值：targets 的 边/中心/边 + 画布 0/中/宽 + points 的顶点 */
export function snapCandidates(opts: SnapOptions, axis: 'x' | 'y'): Array<{ value: number; kind: SnapKind }> {
  const out: Array<{ value: number; kind: SnapKind }> = []
  const push = (v: number, kind: SnapKind): void => {
    if (Number.isFinite(v)) out.push({ value: v, kind })
  }
  for (const t of opts.targets || []) {
    if (!t) continue
    if (axis === 'x') {
      push(t.x, 'shape')
      push(t.x + t.w / 2, 'shape')
      push(t.x + t.w, 'shape')
    } else {
      push(t.y, 'shape')
      push(t.y + t.h / 2, 'shape')
      push(t.y + t.h, 'shape')
    }
  }
  const ab = opts.artboard
  if (ab) {
    if (axis === 'x') {
      push(0, 'shape')
      push(ab.w / 2, 'shape')
      push(ab.w, 'shape')
    } else {
      push(0, 'shape')
      push(ab.h / 2, 'shape')
      push(ab.h, 'shape')
    }
  }
  for (const p of opts.points || []) {
    if (!p) continue
    push(axis === 'x' ? p.x : p.y, 'node')
  }
  return out
}

/** 在一组"测量值"里找最近的候选（含网格）；返回修正量与来源 */
function bestSnap(measures: number[], candidates: Array<{ value: number; kind: SnapKind }>, grid: { enabled?: boolean; size: number } | undefined, threshold: number): SnapHit | null {
  if (!(threshold > 0)) return null
  let best: SnapHit | null = null
  const consider = (delta: number, value: number, kind: SnapKind): void => {
    const dist = Math.abs(delta)
    if (dist > threshold + 1e-7) return
    if (!best || dist < best.distance - 1e-7 || (dist <= best.distance + 1e-7 && KIND_PRIORITY[kind] > KIND_PRIORITY[best.kind])) {
      best = { delta, value, kind, distance: dist }
    }
  }
  for (const m of measures) {
    for (const c of candidates) consider(c.value - m, c.value, c.kind)
    if (grid && grid.enabled !== false && grid.size > 0) {
      const g = Math.round(m / grid.size) * grid.size
      consider(g - m, g, 'grid')
    }
  }
  return best
}

function guide(hit: SnapHit | null, axis: 'x' | 'y'): SnapGuide | null {
  if (!hit) return null
  const h = hit as SnapHit
  return { axis, value: h.value, kind: h.kind }
}

/** 同轴同值（0.001 内）的 guide 只画一根 */
export function dedupeGuides(guides: Array<SnapGuide | null>): SnapGuide[] {
  const seen = new Set<string>()
  const kept: SnapGuide[] = []
  for (const g of guides) {
    if (!g) continue
    const key = `${g.axis}:${Math.round(g.value * 1e3)}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(g)
  }
  return kept
}

export interface MoveSnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

/** 拖动整体：以 {x, y, w, h} 的 边/中线 为测量值，返回修正后的 dx/dy 与要画的 guide */
export function snapMove(box: Box, dx: number, dy: number, opts: SnapOptions): MoveSnapResult {
  if (!opts.enabled || !box) return { dx, dy, guides: [] }
  const threshold = Number(opts.threshold) || 0
  if (threshold <= 0) return { dx, dy, guides: [] }
  const xs = snapCandidates(opts, 'x')
  const ys = snapCandidates(opts, 'y')
  const hitX = bestSnap([box.x + dx, box.x + box.w / 2 + dx, box.x + box.w + dx], xs, opts.grid, threshold)
  const hitY = bestSnap([box.y + dy, box.y + box.h / 2 + dy, box.y + box.h + dy], ys, opts.grid, threshold)
  return {
    dx: dx + (hitX ? hitX.delta : 0),
    dy: dy + (hitY ? hitY.delta : 0),
    guides: dedupeGuides([guide(hitX, 'x'), guide(hitY, 'y')])
  }
}

export interface ResizeSnapResult {
  bounds: Box
  guides: SnapGuide[]
}

/** 拉手缩放：只吸被拖的那两条边，最小 1 用户单位 */
export function snapResize(bounds: Box, handles: string[], opts: SnapOptions): ResizeSnapResult {
  if (!opts.enabled || !bounds || !handles) return { bounds, guides: [] }
  const threshold = Number(opts.threshold) || 0
  if (threshold <= 0) return { bounds, guides: [] }
  const xs = snapCandidates(opts, 'x')
  const ys = snapCandidates(opts, 'y')
  const MIN = 1
  let left = bounds.x
  let right = bounds.x + bounds.w
  let top = bounds.y
  let bottom = bounds.y + bounds.h
  const guides: SnapGuide[] = []
  if (handles.includes('w')) {
    const hit = bestSnap([left], xs, opts.grid, threshold)
    if (hit) {
      left += hit.delta
      guides.push(guide(hit, 'x')!)
    }
  }
  if (handles.includes('e')) {
    const hit = bestSnap([right], xs, opts.grid, threshold)
    if (hit) {
      right += hit.delta
      guides.push(guide(hit, 'x')!)
    }
  }
  if (handles.includes('n')) {
    const hit = bestSnap([top], ys, opts.grid, threshold)
    if (hit) {
      top += hit.delta
      guides.push(guide(hit, 'y')!)
    }
  }
  if (handles.includes('s')) {
    const hit = bestSnap([bottom], ys, opts.grid, threshold)
    if (hit) {
      bottom += hit.delta
      guides.push(guide(hit, 'y')!)
    }
  }
  if (right - left < MIN) right = left + MIN
  if (bottom - top < MIN) bottom = top + MIN
  return { bounds: { x: left, y: top, w: right - left, h: bottom - top }, guides: dedupeGuides(guides) }
}

/** 单点吸附（节点拖动） */
export function snapPoint(point: { x: number; y: number } | null, opts: SnapOptions): { point: { x: number; y: number } | null; guides: SnapGuide[] } {
  if (!opts.enabled || !point) return { point, guides: [] }
  const threshold = Number(opts.threshold) || 0
  if (threshold <= 0) return { point, guides: [] }
  const hitX = bestSnap([point.x], snapCandidates(opts, 'x'), opts.grid, threshold)
  const hitY = bestSnap([point.y], snapCandidates(opts, 'y'), opts.grid, threshold)
  return {
    point: { x: point.x + (hitX ? hitX.delta : 0), y: point.y + (hitY ? hitY.delta : 0) },
    guides: dedupeGuides([guide(hitX, 'x'), guide(hitY, 'y')])
  }
}
