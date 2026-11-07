/**
 * SVG path d 串的解析端（序列化端在 geom.ts）。
 *
 * 全命令族都收：M/L/H/V/C/S/Q/T/A/Z，大小写都行（相对命令就地累加），
 * S/T 按前一条同类反射控制点。任何一处读不下去整串判 null——导入层据此回落，
 * 绝不产出"半条路径"。输出的命令不带 id，由 normalizeCommands 统一补。
 */

import type { LoosePathCommand } from './model.ts'

export function parsePathCommands(rawD: string | null | undefined): LoosePathCommand[] | null {
  const s = String(rawD || '')
  let pos = 0
  let curX = 0
  let curY = 0
  let startX = 0
  let startY = 0
  let lastControlX: number | null = null
  let lastControlY: number | null = null
  let lastQuadX: number | null = null
  let lastQuadY: number | null = null
  let prevType = ''

  const skipWs = (): void => {
    while (pos < s.length && /[\s,]/.test(s[pos]!)) pos += 1
  }
  const hasNumber = (): boolean => {
    skipWs()
    return pos < s.length && /[0-9+\-.]/.test(s[pos]!)
  }
  const readNumber = (): number => {
    skipWs()
    const m = /^[+-]?(?:(?:\d+\.\d*)|(?:\.\d+)|(?:\d+))(?:[eE][+-]?\d+)?/.exec(s.slice(pos))
    if (!m) throw new Error('Expected a number')
    pos += m[0].length
    const v = Number(m[0])
    if (!Number.isFinite(v)) throw new Error('Invalid number')
    return v
  }
  const readFlag = (): 0 | 1 => {
    skipWs()
    const ch = s[pos]
    if (ch !== '0' && ch !== '1') throw new Error('Expected an arc flag')
    pos += 1
    return ch === '1' ? 1 : 0
  }
  const readPair = (relative: boolean): { x: number; y: number } => {
    const x = readNumber()
    const y = readNumber()
    return relative ? { x: curX + x, y: curY + y } : { x, y }
  }
  const clearControls = (): void => {
    lastControlX = null
    lastControlY = null
    lastQuadX = null
    lastQuadY = null
  }

  try {
    const out: LoosePathCommand[] = []
    while (pos < s.length) {
      skipWs()
      if (pos >= s.length) break
      const ch = s[pos]!
      if (!/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) return null
      pos += 1
      const lower = ch.toLowerCase()
      const relative = ch === lower

      if (lower === 'z') {
        out.push({ type: 'Z' })
        curX = startX
        curY = startY
        prevType = 'Z'
        clearControls()
        continue
      }
      if (!hasNumber()) return null

      if (lower === 'm') {
        let first = true
        do {
          const p = readPair(relative)
          curX = p.x
          curY = p.y
          if (first) {
            startX = p.x
            startY = p.y
            out.push({ type: 'M', x: p.x, y: p.y })
            first = false
          } else {
            out.push({ type: 'L', x: p.x, y: p.y })
          }
        } while (hasNumber())
        prevType = 'M'
        clearControls()
      } else if (lower === 'l') {
        do {
          const p = readPair(relative)
          curX = p.x
          curY = p.y
          out.push({ type: 'L', x: p.x, y: p.y })
        } while (hasNumber())
        prevType = 'L'
        clearControls()
      } else if (lower === 'h' || lower === 'v') {
        do {
          const d = readNumber()
          if (lower === 'h') curX = relative ? curX + d : d
          else curY = relative ? curY + d : d
          out.push({ type: 'L', x: curX, y: curY })
        } while (hasNumber())
        prevType = 'L'
        clearControls()
      } else if (lower === 'c') {
        do {
          const c1 = readPair(relative)
          const c2 = readPair(relative)
          const end = readPair(relative)
          out.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y })
          curX = end.x
          curY = end.y
          lastControlX = c2.x
          lastControlY = c2.y
          lastQuadX = null
          lastQuadY = null
          prevType = 'C'
        } while (hasNumber())
      } else if (lower === 's') {
        do {
          const reflected: { x: number; y: number } =
            (prevType === 'C' || prevType === 'S') && lastControlX !== null && lastControlY !== null
              ? { x: 2 * curX - lastControlX, y: 2 * curY - lastControlY }
              : { x: curX, y: curY }
          const c2 = readPair(relative)
          const end = readPair(relative)
          out.push({ type: 'C', x1: reflected.x, y1: reflected.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y })
          curX = end.x
          curY = end.y
          lastControlX = c2.x
          lastControlY = c2.y
          lastQuadX = null
          lastQuadY = null
          prevType = 'S'
        } while (hasNumber())
      } else if (lower === 'q') {
        do {
          const c = readPair(relative)
          const end = readPair(relative)
          out.push({ type: 'Q', x1: c.x, y1: c.y, x: end.x, y: end.y })
          curX = end.x
          curY = end.y
          lastQuadX = c.x
          lastQuadY = c.y
          lastControlX = null
          lastControlY = null
          prevType = 'Q'
        } while (hasNumber())
      } else if (lower === 't') {
        do {
          const reflected2: { x: number; y: number } =
            (prevType === 'Q' || prevType === 'T') && lastQuadX !== null && lastQuadY !== null
              ? { x: 2 * curX - lastQuadX, y: 2 * curY - lastQuadY }
              : { x: curX, y: curY }
          const end = readPair(relative)
          out.push({ type: 'Q', x1: reflected2.x, y1: reflected2.y, x: end.x, y: end.y })
          curX = end.x
          curY = end.y
          lastQuadX = reflected2.x
          lastQuadY = reflected2.y
          lastControlX = null
          lastControlY = null
          prevType = 'T'
        } while (hasNumber())
      } else if (lower === 'a') {
        do {
          const rx = Math.abs(readNumber())
          const ry = Math.abs(readNumber())
          const rotation = readNumber()
          const largeArc = readFlag()
          const sweep = readFlag()
          const end = readPair(relative)
          out.push({ type: 'A', rx, ry, rotation, largeArc, sweep, x: end.x, y: end.y })
          curX = end.x
          curY = end.y
        } while (hasNumber())
        prevType = 'A'
        clearControls()
      }
    }
    return out
  } catch {
    return null
  }
}
