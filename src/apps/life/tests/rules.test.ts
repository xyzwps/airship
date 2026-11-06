import { describe, expect, it } from 'vitest'
import {
  countAlive,
  emptyBoard,
  liveCounts,
  measure,
  neighbors,
  randomBoard,
  sameBoard,
  shapeCells,
  shapeOf,
  shapeSize,
  stamp,
  step,
  steps,
  type Board,
  type Edge
} from '../life'
import { GROUPS, PATTERNS, patternPlacement, patternsOf, type Pattern } from '../patterns'

/**
 * LF 册子里"推演与图形库"那一半（界面那一半在 life-ui.test.tsx）。
 *
 * 这一份不看界面：它钉的是"说明书不许凭记忆写"——图形库每一句周期、位移、
 * 灭绝代数、活格数，都在这里用同一台推演量一遍。
 */

/** 用例统一在最小那一档网格上量：换档不该改变图形的行为，但判据要挑最严的那一档 */
const N = 100
/**
 * 图形库的说明书量的是"这堆东西自己的行为"，所以按**墙**量：
 * 环绕会让长寿种子在跑到边上时从对边再撞自己一次，那个数字就不是图形本身的性质了。
 */
const WALL: Edge = 'wall'

function board(rows: string[], atX = 0, atY = 0, edge: Edge = WALL): Board {
  return stamp(emptyBoard(N, edge), { rows }, atX, atY)
}

/** 把一个图形按库里的落点铺到空网格上 */
function shapeBoard(pattern: Pattern, edge: Edge = WALL): Board {
  const at = patternPlacement(pattern, N)
  return stamp(emptyBoard(N, edge), pattern, at.x, at.y)
}

const named = (id: string): Pattern => PATTERNS.find((p) => p.id === id)!

describe('规则与边界（LF-007 / LF-008 / LF-009 / LF-028 / LF-030）', () => {
  it('LF-007 墙那一档下，左上角那三格只数得到网格里的邻居', () => {
    const g = board(['##', '#..'], 0, 0)
    expect(neighbors(g, 0, 0)).toBe(2)
    // 网格外没有格子可数，也没有从右下角绕回来的邻居
    expect(neighbors(g, N - 1, N - 1)).toBe(0)
    const next = step(g)
    expect(next.cells[0]).toBe(1)
    expect(next.cells[1]).toBe(1)
    expect(next.cells[N]).toBe(1)
    // (1,1) 三个邻居凑满，生出来
    expect(next.cells[N + 1]).toBe(1)
  })

  it('LF-008 三格一线横一下竖一下，2 代回到原样', () => {
    const g = board(['###'], 40, 40)
    const one = step(g)
    const two = step(one)
    // 第 1 代是一列三格
    expect(shapeOf(one).key).toBe(shapeOf(board(['#', '#', '#'], 41, 40)).key)
    // 第 2 代回到横的，位置一格没动
    expect(sameBoard(two, g)).toBe(true)
  })

  it('LF-009 两格挨着活不成，四格方块永远原样', () => {
    expect(countAlive(step(board(['##'], 40, 40)))).toBe(0)
    const block = board(['##', '##'], 40, 40)
    expect(sameBoard(steps(block, 10), block)).toBe(true)
  })

  it('LF-028 环绕那一档下，贴边的格子从对边接上', () => {
    const wrap = board(['#'], N - 1, N - 1, 'wrap')
    const wall = board(['#'], N - 1, N - 1, 'wall')
    // 左上角数到的那一个邻居，就是绕过来的右下角
    expect(neighbors(wrap, 0, 0)).toBe(1)
    expect(neighbors(wall, 0, 0)).toBe(0)
    // 对边也算：右下角那一格自己的邻居里，(0,0) 那位在环绕下看得见
    expect(neighbors(wrap, N - 1, N - 1)).toBe(0)
  })

  it('LF-030 同一只滑翔机：环绕下走两百代还是五格，墙下会碎在边上', () => {
    const glider = named('glider')
    const onWrap = steps(shapeBoard(glider, 'wrap'), 200)
    const onWall = steps(shapeBoard(glider, WALL), 200)
    expect(countAlive(onWrap)).toBe(5)
    expect(countAlive(onWall)).not.toBe(5)
  })
})

describe('网格大小与随机起点（LF-006 / LF-016）', () => {
  it('LF-006 每个图形都非空、外框不超过最小那一档网格，且五组都不空', () => {
    const groupIds = GROUPS.map((g) => g.id)
    expect(groupIds).toEqual(['still', 'oscillator', 'spaceship', 'methuselah', 'gun'])
    for (const p of PATTERNS) {
      expect(shapeCells(p).length, p.name).toBeGreaterThan(0)
      const { w, h } = shapeSize(p)
      expect(w, p.name).toBeLessThanOrEqual(100)
      expect(h, p.name).toBeLessThanOrEqual(100)
      expect(groupIds, p.name).toContain(p.group)
    }
    for (const g of groupIds) expect(patternsOf(g).length, g).toBeGreaterThan(0)
  })

  it('LF-016 同一种子与同一密度铺两次，逐格一样', () => {
    expect(sameBoard(randomBoard(100, 0.3, 7), randomBoard(100, 0.3, 7))).toBe(true)
    expect(sameBoard(randomBoard(100, 0.3, 7), randomBoard(100, 0.3, 8))).toBe(false)
    const cells = countAlive(randomBoard(100, 0.3, 3))
    // 密度 0.3 铺满 10000 格：不是空的，也不是满的
    expect(cells).toBeGreaterThan(1000)
    expect(cells).toBeLessThan(100 * 100)
  })
})

describe('说明书里的数字是量出来的（LF-018 / LF-019 / LF-020 / LF-021 / LF-022）', () => {
  it('LF-018 静止体周期 1，振荡器各自周期', () => {
    const expect1: Record<string, number> = {
      block: 1,
      boat: 1,
      beehive: 1,
      loaf: 1,
      blinker: 2,
      toad: 2,
      beacon: 2,
      pulsar: 3,
      pentadecathlon: 15
    }
    for (const [id, period] of Object.entries(expect1)) {
      const p = named(id)
      const m = measure(shapeBoard(p), 60)
      expect(m.period, `${p.name} 的周期`).toBe(period)
      // 周期 1 就是不动点：说明书才敢写"一动不动"
      if (period === 1) expect(sameBoard(step(shapeBoard(p)), shapeBoard(p)), p.name).toBe(true)
    }
  })

  it('LF-019 飞船一个周期走几格，与说明书一致', () => {
    const glider = measure(shapeBoard(named('glider')), 40)
    expect(glider.period).toBe(4)
    // drift 是"每代"，乘以周期才是"每周期走几格"：往右下一格
    expect(glider.drift!.x * glider.period!).toBe(1)
    expect(glider.drift!.y * glider.period!).toBe(1)

    const lwss = measure(shapeBoard(named('lwss')), 40)
    expect(lwss.period).toBe(4)
    expect(lwss.drift!.x * lwss.period!).toBe(2)
    expect(lwss.drift!.y * lwss.period!).toBe(0)
  })

  it('LF-020 挣扎者第 130 代死干净，橡果与 R 五连块跑很久还在变', () => {
    expect(measure(shapeBoard(named('diehard')), 200).diedAt).toBe(130)
    for (const id of ['acorn', 'r-pentomino']) {
      const p = named(id)
      const g = shapeBoard(p)
      expect(measure(g, 200).period, p.name).toBeNull()
      expect(countAlive(steps(g, 300)), p.name).toBeGreaterThan(0)
    }
  })

  it('LF-021 脉冲星活格数按 48 → 56 → 72 → 48 走', () => {
    expect(liveCounts(shapeBoard(named('pulsar')), 3).slice(0, 4)).toEqual([48, 56, 72, 48])
  })

  it('LF-022 机枪每 30 代多出一只滑翔机，落点贴着左上角', () => {
    const gun = named('gosper-gun')
    expect(patternPlacement(gun, N)).toEqual({ x: 1, y: 1 })
    const counts = liveCounts(shapeBoard(gun), 90)
    expect([counts[0], counts[30], counts[60], counts[90]]).toEqual([36, 41, 46, 51])
    // 多出来的 5 格正是滑翔机的格数
    expect(counts[30]! - counts[0]!).toBe(5)
    expect(counts[60]! - counts[30]!).toBe(5)
  })

  it('LF-022 换到更大的网格不改变机枪的行为（300×300 上同样每 30 代 +5）', () => {
    const gun = named('gosper-gun')
    const at = patternPlacement(gun, 300)
    const counts = liveCounts(stamp(emptyBoard(300), gun, at.x, at.y), 60)
    expect(counts[30]! - counts[0]!).toBe(5)
    expect(counts[60]! - counts[30]!).toBe(5)
  })
})
