import type { Box } from './geom.ts'

/**
 * 对齐与等距分布。对齐是"每个形状相对目标包围盒的平移量"；
 * 分布按主轴排序后两端不动、中间等空隙（<2 个全是 0 位移，<3 个由调用方拒绝并念文案）。
 */

export type AlignKind = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'

export interface Alignable {
  id: string
  bounds: Box | null
}

/** 把形状 bbox 对齐到 target box；bbox 缺失原样返回 0 位移 */
export function alignOffset(shapeBox: Box | null, target: Box | null, kind: AlignKind): { dx: number; dy: number } {
  if (!shapeBox || !target) return { dx: 0, dy: 0 }
  switch (kind) {
    case 'left':
      return { dx: target.x - shapeBox.x, dy: 0 }
    case 'center':
      return { dx: target.x + target.w / 2 - (shapeBox.x + shapeBox.w / 2), dy: 0 }
    case 'right':
      return { dx: target.x + target.w - (shapeBox.x + shapeBox.w), dy: 0 }
    case 'top':
      return { dx: 0, dy: target.y - shapeBox.y }
    case 'middle':
      return { dx: 0, dy: target.y + target.h / 2 - (shapeBox.y + shapeBox.h / 2) }
    case 'bottom':
      return { dx: 0, dy: target.y + target.h - (shapeBox.y + shapeBox.h) }
    default:
      return { dx: 0, dy: 0 }
  }
}

export interface DistributeMove {
  id: string
  dx: number
  dy: number
}

/** 等距分布后的位移表；排序：主轴同值时看另一轴兜底 */
export function distributeOffsets(items: Alignable[], axis: 'x' | 'y'): DistributeMove[] {
  const sorted = (Array.isArray(items) ? items : [])
    .filter((it) => it && it.bounds)
    .slice()
    .sort((a, b) => {
      const A = a.bounds!
      const B = b.bounds!
      return axis === 'y' ? A.y - B.y || A.x - B.x : A.x - B.x || A.y - B.y
    })
  if (sorted.length < 2) return sorted.map((it) => ({ id: it.id, dx: 0, dy: 0 }))
  const first = sorted[0]!.bounds!
  const last = sorted[sorted.length - 1]!.bounds!
  const low = axis === 'y' ? first.y : first.x
  const high = axis === 'y' ? last.y + last.h : last.x + last.w
  const total = sorted.reduce((s, it) => s + (axis === 'y' ? it.bounds!.h : it.bounds!.w), 0)
  const gap = (high - low - total) / (sorted.length - 1)
  let cursor = low
  return sorted.map((it) => {
    const b = it.bounds!
    const at = axis === 'y' ? b.y : b.x
    const delta = cursor - at
    cursor += (axis === 'y' ? b.h : b.w) + gap
    return axis === 'y' ? { id: it.id, dx: 0, dy: delta } : { id: it.id, dx: delta, dy: 0 }
  })
}

/** 位移是否已经成立（用于"已经对齐/间距已经均匀"的提示）；0.01 容差 */
export function isNoop(moves: Array<{ dx: number; dy: number }>): boolean {
  return moves.every((m) => Math.abs(m.dx) < 0.01 && Math.abs(m.dy) < 0.01)
}
