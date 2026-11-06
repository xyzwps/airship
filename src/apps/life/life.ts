/**
 * 生命游戏的推演内核：只有常量、数据与纯函数，不认识 React，也不认识壳。
 *
 * 三条自己定的规矩：
 *   - **只有网格，没有"画布"**：世界就是 n×n 个格子（100 / 200 / 300 三档）。
 *     早先这里还有一层"1000×1000 世界像素、每格 10 像素"的抽象，那是多余的一层——
 *     它让"缩放"变成"缩世界"，还要额外解释一格到底多大。现在缩放只回答一个问题：
 *     **一格在屏幕上画几像素**。
 *   - 越界怎么数邻居是**边界那一档**的事：默认环绕（对边接上，滑翔机永远撞不碎），
 *     也可以选墙（贴边就碎，那一课也要看得见）。判据见 specs/life.md LF-007 / LF-028。
 *   - 活不活只有 0/1，用 Uint8Array 摊平存。300×300 是 90000 格，一次推演 72 万次邻居加法，
 *     对象与 Set 那两种写法在这一档尺寸上会先撑不住。
 */

/** 网格大小的档位（每边格数） */
export const GRID_SIZES = [100, 200, 300] as const
export type GridSize = (typeof GRID_SIZES)[number]

/**
 * 边界那一档：数邻居走到网格外面时怎么办。
 *   - `wrap` 环绕：对边接上，整张网格是个环面——滑翔机走到右下角就从左上角继续，永远撞不碎。
 *   - `wall` 墙：外面没有格子，贴边的结构会撞碎——这也是要看得见的一课。
 * 它是这张盘自己的属性（跟着盘走），不然一次推演里可能一半按墙数、一半按环绕数。
 */
export type Edge = 'wrap' | 'wall'

/** 一张盘：边长、边界那一档、摊平的格子 */
export interface Board {
  readonly n: number
  readonly edge: Edge
  readonly cells: Uint8Array
}

/** 一格的屏幕像素小于这个数就不画细网格线——那时线比格子还粗，只会糊成一团 */
export const GRID_LINE_MIN_PX = 6
/** 细线画不出来时，每隔这么多格仍要有一条刻度线，否则看不出这堆东西有多大 */
export const MAJOR_EVERY = 10

/** 空格子 */
export function emptyBoard(n: number, edge: Edge = 'wrap'): Board {
  return { n, edge, cells: new Uint8Array(n * n) }
}

export function inBounds(board: Board, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < board.n && y < board.n
}

/** 取一格；越界时按边界那一档办：环绕就从对边接上，墙就当那里没有格子 */
export function cellAt(board: Board, x: number, y: number): number {
  const { n, edge } = board
  if (x < 0 || x >= n || y < 0 || y >= n) {
    if (edge !== 'wrap') return 0
    // 只绕一圈就够：邻居最远只差一格，而网格比任何图形都大
    const wx = x < 0 ? x + n : x >= n ? x - n : x
    const wy = y < 0 ? y + n : y >= n ? y - n : y
    if (wx < 0 || wx >= n || wy < 0 || wy >= n) return 0
    return board.cells[wy * n + wx]!
  }
  return board.cells[y * n + x]!
}

/** 八邻域里的活格数 */
export function neighbors(board: Board, x: number, y: number): number {
  let m = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      m += cellAt(board, x + dx, y + dy)
    }
  }
  return m
}

/**
 * 一代规则（B3/S23）：活格有 2 或 3 个活邻居就活下来，死格正好 3 个就生。
 * 单独一颗键，是因为界面要在"跑着的世代"之外还能钉住某一格讲清为什么。
 */
export function survives(live: number, wasAlive: boolean): boolean {
  return wasAlive ? live === 2 || live === 3 : live === 3
}

/** 推进一步，返回新盘（不原地改：编辑与推演共用一份引用会互相踩） */
export function step(board: Board): Board {
  const { n, cells } = board
  const next = new Uint8Array(n * n)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x
      next[i] = survives(neighbors(board, x, y), cells[i] === 1) ? 1 : 0
    }
  }
  return { n, edge: board.edge, cells: next }
}

/** 走 k 代 */
export function steps(board: Board, k: number): Board {
  let cur = board
  for (let i = 0; i < k; i++) cur = step(cur)
  return cur
}

export function countAlive(board: Board): number {
  let m = 0
  for (let i = 0; i < board.cells.length; i++) m += board.cells[i]!
  return m
}

export function sameBoard(a: Board, b: Board): boolean {
  if (a.n !== b.n || a.cells.length !== b.cells.length) return false
  for (let i = 0; i < a.cells.length; i++) if (a.cells[i] !== b.cells[i]) return false
  return true
}

/** 整个网格有没有一格活着 */
export function isDead(board: Board): boolean {
  return countAlive(board) === 0
}

/**
 * 置活/置死一格，返回新盘；这一格本来就这副样子或越界就返回 null。
 * 界面靠"是不是 null"决定要不要换 state——拖动时鼠标每动一下都进来一趟，
 * 没变化就不该惊动整棵 React 树。
 */
export function paintCell(board: Board, x: number, y: number, alive: boolean): Board | null {
  if (!inBounds(board, x, y)) return null
  const i = y * board.n + x
  const want = alive ? 1 : 0
  if (board.cells[i] === want) return null
  const cells = new Uint8Array(board.cells)
  cells[i] = want
  return { n: board.n, edge: board.edge, cells }
}

/** 屏幕像素 → 格坐标（向下取整）；越界返回 null */
export function cellOfPoint(px: number, py: number, cellPx: number, board: Board) {
  const x = Math.floor(px / cellPx)
  const y = Math.floor(py / cellPx)
  return inBounds(board, x, y) ? { x, y } : null
}

/**
 * 一个图形：`rows` 是逐行的形状，`#` 活、`.` 死；左上角对齐，行尾的死格可以省。
 * 之所以用字符串而不是坐标数组：图形库有二十来项，形状本身才是要看的东西，
 * 坐标列表读起来全是噪声，而且形状写错了肉眼看得见、坐标写错了看不见。
 */
export interface Shape {
  readonly rows: readonly string[]
}

/** 形状展开成相对左上角的活格坐标 */
export function shapeCells(shape: Shape): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  shape.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') out.push({ x, y })
  })
  return out
}

/** 形状的外框（宽×高，单位是格） */
export function shapeSize(shape: Shape): { w: number; h: number } {
  const h = shape.rows.length
  const w = shape.rows.reduce((max, row) => Math.max(max, row.length), 0)
  return { w, h }
}

/**
 * 把一个图形盖到盘上，`at` 是它左上角落到的格坐标。
 * 落在网格外的格子直接丢掉（不报错：图形库里的东西本来就都在范围内，
 * 越界只会来自用户把边缘当落点，那时候盖得进去的部分就是全部能给的）。
 */
export function stamp(board: Board, shape: Shape, atX: number, atY: number): Board {
  const cells = new Uint8Array(board.cells)
  for (const cell of shapeCells(shape)) {
    const x = atX + cell.x
    const y = atY + cell.y
    if (inBounds(board, x, y)) cells[y * board.n + x] = 1
  }
  return { n: board.n, edge: board.edge, cells }
}

/** 图形放在网格正中时它的左上角落在哪一格（外框居中，不是左上角居中） */
export function centeredAt(n: number, shape: Shape): { x: number; y: number } {
  const { w, h } = shapeSize(shape)
  return { x: Math.floor((n - w) / 2), y: Math.floor((n - h) / 2) }
}

/**
 * 可复现的伪随机（xorshift32）。
 * 用它而不是 Math.random：随机填充是"给学习者一个起点"的功能，
 * 同一个种子必须给同一张图，否则用例钉不住，用户也说不出"我刚看到的那个图案"。
 */
export function makeRandom(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s / 0x100000000
  }
}

/** 按密度随机铺满整张网格（密度 0~1） */
export function randomBoard(n: number, density: number, seed: number, edge: Edge = 'wrap'): Board {
  const board = emptyBoard(n, edge)
  const rand = makeRandom(seed)
  for (let i = 0; i < board.cells.length; i++) board.cells[i] = rand() < density ? 1 : 0
  return board
}

/**
 * 形状指纹：把活格平移到"外框左上角对齐原点"再压成字符串，并记下外框落点。
 * 飞船每 4 代整体挪一格，绝对坐标永不重复，所以要按形状本身比——
 * 周期与位移是两件事。
 */
export function shapeOf(board: Board): { key: string; x: number; y: number; cells: number } {
  const { n, cells } = board
  let minX = n
  let minY = n
  let maxX = -1
  let maxY = -1
  let count = 0
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (cells[y * n + x] !== 1) continue
      count++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (count === 0) return { key: '', x: 0, y: 0, cells: 0 }
  let s = ''
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) s += cells[y * n + x] === 1 ? '1' : '0'
    s += '/'
  }
  return { key: s, x: minX, y: minY, cells: count }
}

export interface Measurement {
  /** 形状重复的最小代数；到 maxGens 还没重复就是 null */
  period: number | null
  /** 一个周期内形状整体挪了多少格（飞船非零，静止体与原地振荡为 0） */
  drift: { x: number; y: number } | null
  /** 第几代全灭；没灭就是 null */
  diedAt: number | null
}

/**
 * 从第 0 代起跑，量出这个局面的周期、每周期位移与灭绝代数。
 *
 * 图形库说明书里每一个数字都由它测出来（用例 LF-015 到 LF-019 把它们钉住），不靠谁记性好。
 * 只给"这堆东西到底是什么行为"做判定用，别放进每帧热路径。
 */
export function measure(board: Board, maxGens: number): Measurement {
  const seen = new Map<string, { gen: number; x: number; y: number }>()
  const first = shapeOf(board)
  seen.set(first.key, { gen: 0, x: first.x, y: first.y })
  let cur = board
  for (let gen = 1; gen <= maxGens; gen++) {
    cur = step(cur)
    const shape = shapeOf(cur)
    if (shape.cells === 0) return { period: null, drift: null, diedAt: gen }
    const hit = seen.get(shape.key)
    if (hit) {
      const period = gen - hit.gen
      return {
        period,
        drift: { x: (shape.x - hit.x) / period, y: (shape.y - hit.y) / period },
        diedAt: null
      }
    }
    seen.set(shape.key, { gen, x: shape.x, y: shape.y })
  }
  return { period: null, drift: null, diedAt: null }
}

/** 逐代数活格，用例与"这堆东西到底在干什么"都用得上 */
export function liveCounts(board: Board, gens: number): number[] {
  const out: number[] = [countAlive(board)]
  let cur = board
  for (let i = 0; i < gens; i++) {
    cur = step(cur)
    out.push(countAlive(cur))
  }
  return out
}
