// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { normalizeDoc, normalizeCommands, regularPolygonPoints, makeId } from '../model.ts'
import {
  fmt,
  commandsToPath,
  rectToPath,
  ellipseToPath,
  pathCommandsBBox,
  stepZoom,
  zoomFromWheel,
  zoomLabel,
  fitZoom
} from '../geom.ts'
import { parsePathCommands } from '../pathdata.ts'
import { parseTransformAttr, viewBoxToFit, invertMatrix, multiply, transformArc } from '../matrix.ts'
import { snapMove, snapPoint, dedupeGuides } from '../snap.ts'
import { alignOffset, distributeOffsets } from '../align.ts'
import { exportFromModel } from '../svgExport.ts'
import { cssFamilyFor } from '../fonts.ts'
import { runBoolean } from '../booleanOps.ts'

/**
 * 纯逻辑层的自检（不挂 AL 编号：AL 钉的是界面上读得到的话，这里是它的算式底座）。
 */

describe('模型净化', () => {
  it('缺省文档是 960×640 纸底，且画布没有名字', () => {
    const doc = normalizeDoc({}, 'zh')
    expect([doc.width, doc.height, doc.background]).toEqual([960, 640, '#fffdf8'])
    expect('name' in doc).toBe(false)
    // 旧存档里残留的 name 读到时忽略，不迁移
    expect('name' in normalizeDoc({ name: '旧名字' }, 'zh')).toBe(false)
  })

  it('尺寸钳在 64..10000，坏形状整条丢弃', () => {
    const doc = normalizeDoc(
      { width: 20, height: 99999, shapes: [{ type: 'nope' }, { type: 'rect', w: -5 }] },
      'en'
    )
    expect([doc.width, doc.height]).toEqual([64, 10000])
    expect(doc.shapes).toHaveLength(1)
    expect(doc.shapes[0]!.type).toBe('rect')
  })

  it('直线的填充恒为 none，默认名带序号与语言', () => {
    const doc = normalizeDoc({ shapes: [{ type: 'line' }, { type: 'line', fill: '#ff0000' }] }, 'zh')
    expect(doc.shapes.map((s) => s.fill)).toEqual(['none', 'none'])
    expect(doc.shapes.map((s) => s.name)).toEqual(['直线 1', '直线 2'])
  })

  it('命令净化丢类型外的条目并补 id', () => {
    const cmds = normalizeCommands([{ type: 'X' }, { type: 'M', x: 'abc', y: 10 }, { type: 'Z' }])
    expect(cmds.map((c) => c.type)).toEqual(['M', 'Z'])
    expect(cmds[0]).toMatchObject({ x: 200, y: 10 })
    expect(cmds.every((c) => typeof c.id === 'string' && c.id.length > 0)).toBe(true)
  })

  it('正多边形边数钳 3..24，起始角指向正上方', () => {
    const pts = regularPolygonPoints(0, 0, 10, 100)
    expect(pts).toHaveLength(24)
    expect(pts[0]!.x).toBeCloseTo(0, 6)
    expect(pts[0]!.y).toBeCloseTo(-10, 6)
  })

  it('id 是 前缀_时间36_自增36', () => {
    expect(makeId('s')).toMatch(/^s_[0-9a-z]+_[0-9a-z]+$/)
  })
})

describe('数字口径与 d 串', () => {
  it('fmt 最多两位、去尾零、-0 写成 0', () => {
    expect(fmt(12)).toBe('12')
    expect(fmt(12.005)).toBe('12.01')
    expect(fmt(-0)).toBe('0')
    expect(fmt(1.5, 6)).toBe('1.5')
  })

  it('命令串只用绝对命令，A 的标志位是裸 0/1', () => {
    const d = commandsToPath([
      { id: 'a', type: 'M', x: 0, y: 0 },
      { id: 'b', type: 'A', rx: 7, ry: 3.5, rotation: 0, largeArc: 1, sweep: 0, x: 14, y: 0 },
      { id: 'c', type: 'Z' }
    ])
    expect(d).toBe('M 0 0 A 7 3.5 0 1 0 14 0 Z')
  })

  it('直角矩形走 H/V 简写，圆角矩形四段弧都是 sweep=1', () => {
    expect(rectToPath({ x: 0, y: 0, w: 10, h: 10, rx: 0 })).toBe('M 0 0 H 10 V 10 H 0 Z')
    const r = rectToPath({ x: 0, y: 0, w: 10, h: 10, rx: 30 })
    expect(r).toContain('A 5 5 0 0 1 10 5')
  })

  it('椭圆是两段大弧、从 9 点方向起手', () => {
    expect(ellipseToPath({ type: 'ellipse', cx: 0, cy: 0, rx: 2, ry: 1 })).toBe(
      'M -2 0 A 2 1 0 1 0 2 0 A 2 1 0 1 0 -2 0 Z'
    )
  })

  it('包围盒吃到曲线极值与弧极值', () => {
    const box = pathCommandsBBox([
      { id: 'a', type: 'M', x: 0, y: 0 },
      { id: 'b', type: 'C', x1: 0, y1: 100, x2: 100, y2: 100, x: 100, y: 0 }
    ])
    expect(box.w).toBeCloseTo(100, 6)
    expect(box.h).toBeGreaterThan(74)
    const arc = pathCommandsBBox([
      { id: 'a', type: 'M', x: -5, y: 0 },
      { id: 'b', type: 'A', rx: 5, ry: 5, rotation: 0, largeArc: 1, sweep: 1, x: 5, y: 0 }
    ])
    expect(arc.y).toBeCloseTo(-5, 6)
  })
})

describe('d 串解析', () => {
  it('相对与简写都展开成绝对命令', () => {
    const cmds = parsePathCommands('m 10 10 h 20 v 10 l -10 -10 z')!
    expect(cmds.map((c) => c.type)).toEqual(['M', 'L', 'L', 'L', 'Z'])
    expect(cmds[3]).toMatchObject({ x: 20, y: 10 })
  })

  it('S/T 反射前一条控制点', () => {
    const cmds = parsePathCommands('M 0 0 C 10 0 20 0 30 0 S 60 0 70 0')!
    expect(cmds[2]).toMatchObject({ type: 'C', x1: 40, y1: 0 })
    const q = parsePathCommands('M 0 0 Q 10 10 20 0 T 40 0')!
    expect(q[2]).toMatchObject({ type: 'Q', x1: 30, y1: -10 })
  })

  it('读不下去就整串作废，弧标志只认 0/1', () => {
    expect(parsePathCommands('M 0 0 L')).toBeNull()
    expect(parsePathCommands('M 0 0 A 5 5 0 2 0 10 10')).toBeNull()
    expect(parsePathCommands('')).toEqual([])
  })
})

describe('矩阵与弧', () => {
  it('transform 串：六个函数都认，别的整体作废', () => {
    expect(parseTransformAttr('translate(3 4) scale(2)')).toMatchObject({ a: 2, b: 0, c: 0, d: 2, e: 3, f: 4 })
    expect(parseTransformAttr('translate(10px)')).toBeNull()
    expect(parseTransformAttr('skewX(45)')!.c).toBeCloseTo(1, 6)
    expect(parseTransformAttr('')).toMatchObject({ a: 1, e: 0 })
  })

  it('viewBox 的 meet/slice/none 三档', () => {
    expect(viewBoxToFit([0, 0, 100, 50], 200, 200, 'xMidYMid meet')).toMatchObject({ a: 2, e: 0, f: 50 })
    expect(viewBoxToFit([0, 0, 100, 50], 200, 200, 'none')).toMatchObject({ a: 2, d: 4 })
    expect(viewBoxToFit([0, 0, 100, 50], 200, 200, 'xMidYMid slice')).toMatchObject({ a: 4, e: -100, f: 0 })
    expect(viewBoxToFit([0, 0, 100, 50], 200, 200, 'none')).toMatchObject({ a: 2, d: 4, e: 0, f: 0 })
  })

  it('不可逆矩阵没有逆', () => {
    expect(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toBeNull()
    const m = multiply({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }, { a: 1, b: 0, c: 0, d: 1, e: 5, f: 5 })
    expect(m).toMatchObject({ a: 2, e: 10 })
  })

  it('反射矩阵翻转弧的 sweep，等比缩放只乘半径', () => {
    const mirrored = transformArc({ rx: 5, ry: 5, rotation: 0, largeArc: 0, sweep: 1 }, { a: -1, b: 0, c: 0, d: 1, e: 0, f: 0 })!
    expect(mirrored.sweep).toBe(0)
    const scaled = transformArc({ rx: 5, ry: 3, rotation: 30, largeArc: 1, sweep: 0 }, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 })!
    expect(scaled).toMatchObject({ rx: 10, ry: 6, rotation: 30, largeArc: 1 })
  })
})

describe('吸附与对齐', () => {
  const opts = (extra: Record<string, unknown> = {}) => ({
    enabled: true,
    threshold: 4,
    grid: { enabled: false, size: 8 },
    targets: [{ x: 100, y: 0, w: 10, h: 10 }],
    points: [],
    artboard: { w: 960, h: 640 },
    ...extra
  })

  it('拖动吸形状边与画布中线，同值 guide 只留一根', () => {
    const r = snapMove({ x: 102, y: 318, w: 20, h: 20 }, 0, 0, opts())
    expect(r.dx).toBeCloseTo(-2, 6)
    expect(r.guides.some((g) => g.axis === 'x' && g.value === 100)).toBe(true)
    expect(dedupeGuides([null, ...r.guides, ...r.guides]).length).toBe(r.guides.length)
  })

  it('关掉开关或阈值为 0 就原样返回', () => {
    const off = snapMove({ x: 101, y: 0, w: 10, h: 10 }, 3, 3, opts({ enabled: false }))
    expect([off.dx, off.dy, off.guides.length]).toEqual([3, 3, 0])
    const zero = snapMove({ x: 101, y: 0, w: 10, h: 10 }, 3, 3, opts({ threshold: 0 }))
    expect(zero.guides).toHaveLength(0)
  })

  it('同距离时形状优先于网格', () => {
    const r = snapPoint({ x: 100, y: 16 }, opts({ grid: { enabled: true, size: 8 } }))
    expect(r.guides[0]!.kind).toBe('shape')
  })

  it('分布两端不动中间等空隙', () => {
    const moves = distributeOffsets(
      [
        { id: 'a', bounds: { x: 0, y: 0, w: 10, h: 10 } },
        { id: 'b', bounds: { x: 20, y: 0, w: 10, h: 10 } },
        { id: 'c', bounds: { x: 100, y: 0, w: 10, h: 10 } }
      ],
      'x'
    )
    const byId = Object.fromEntries(moves.map((m) => [m.id, m.dx]))
    expect(byId.a).toBeCloseTo(0, 6)
    expect(byId.c).toBeCloseTo(0, 6)
    expect(byId.b).toBeCloseTo(30, 6)
  })

  it('对齐算式：center 走中线，bottom 贴下沿', () => {
    expect(alignOffset({ x: 0, y: 0, w: 10, h: 10 }, { x: 100, y: 0, w: 20, h: 50 }, 'center').dx).toBe(105)
    expect(alignOffset({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 100 }, 'bottom').dy).toBe(90)
  })
})

describe('缩放档位', () => {
  it('沿档位表步进并钳在 0.5..8', () => {
    expect(stepZoom(1, 1)).toBe(1.25)
    expect(stepZoom(1, -1)).toBe(0.9)
    expect(stepZoom(8, 1)).toBe(8)
    expect(zoomLabel(1.25)).toBe('125%')
  })

  it('滚轮增量映射成 0.5..2 的倍率', () => {
    expect(zoomFromWheel(0)).toBe(1)
    const up = zoomFromWheel(-100)
    expect(up).toBeGreaterThan(1)
    expect(up).toBeLessThanOrEqual(2)
  })

  it('适应屏幕取两边比值的小者，钳在档位区间；量不到可视区回落 1', () => {
    // 可视区 1272×772 相对基准 980×653.33：高边先满 → 1.1816
    expect(fitZoom(1272, 772, 980, 980 / 1.5)).toBeCloseTo(772 / (980 / 1.5), 6)
    // 窗口窄到装不下基准宽：宽边先满，且不会超过 8
    expect(fitZoom(490, 772, 980, 653)).toBeCloseTo(0.5, 6)
    expect(fitZoom(8000, 8000, 980, 653)).toBe(8)
    expect(fitZoom(0, 0, 980, 653)).toBe(1)
  })
})

describe('字体名工具', () => {
  it('CSS 家族名清洗非法字符', () => {
    expect(cssFamilyFor('Helvetica Neue/Bold')).toBe('albedo-HelveticaNeueBold')
  })
})

describe('布尔运算（Paper.js）', () => {
  it('两个重叠矩形并集出一条带曲线的闭合轮廓', () => {
    const out = runBoolean(
      [
        { d: 'M 0 0 H 20 V 20 H 0 Z', fillRule: 'nonzero' },
        { d: 'M 10 10 H 30 V 30 H 10 Z', fillRule: 'nonzero' }
      ],
      'unite'
    )
    expect(out).not.toBeNull()
    expect(out!.segments[0]!.type).toBe('M')
    expect(out!.segments.some((sg) => sg.type === 'Z')).toBe(true)
    expect(out!.area).toBeGreaterThan(400)
  })

  it('互不相交的两个形状算交集是空', () => {
    expect(
      runBoolean(
        [
          { d: 'M 0 0 H 10 V 10 H 0 Z', fillRule: 'nonzero' },
          { d: 'M 100 100 H 110 V 110 H 100 Z', fillRule: 'nonzero' }
        ],
        'intersect'
      )
    ).toBeNull()
  })

  it('串里没有 M 就抛"Empty path operand"', () => {
    expect(() => runBoolean([{ d: 'L 1 1', fillRule: 'nonzero' }, { d: 'M 0 0 L 1 1', fillRule: 'nonzero' }], 'unite')).toThrow(
      /Empty path operand/
    )
  })
})

describe('整幅重画的导出串', () => {
  it('XML 头、没有 title、两空格缩进与属性顺序', () => {
    const doc = normalizeDoc(
      { width: 100, height: 80, name: '测试', shapes: [{ type: 'rect', x: 1, y: 2, w: 30, h: 20, rx: 4, fill: '#ff0000', stroke: 'none', strokeWidth: 0 }] },
      'zh'
    )
    const text = exportFromModel(doc, () => null)
    const lines = text.split('\n')
    expect(lines[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>')
    expect(lines[1]).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80">')
    expect(lines[2]).toContain('fill="#ff0000" stroke="none" stroke-linecap="round"')
    expect(text).not.toContain('<title>')
    expect(text).not.toContain('测试')
    expect(text.endsWith('</svg>\n')).toBe(true)
  })
})
