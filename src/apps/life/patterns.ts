import { centeredAt, type Shape } from './life'

/**
 * 经典图形库 —— 拿来做学习用的那一批。
 *
 * 三条规矩：
 *   1. **形状有出处**：滑翔机、脉冲星、十五棒、轻量飞船、挣扎者、橡果、R 五连块、高斯帕机枪
 *      用的是公开教程里给出的坐标；静止体与振荡器里那几个是从"穷举 4x4 内所有不动点 / 两方块全部
 *      相对摆法"实测出来的。没出处的形状不进库——凭记忆画一个"管"，很可能画成另一样东西。
 *   2. **说明书里的数字是量出来的**：周期、每周期走几格、第几代灭绝、活格数轨迹，
 *      都由 `measure()` / `liveCounts()` 在这台机器上跑出来，用例 LF-011 到 LF-014 逐个核对。
 *      写错一个数字，测试就红，不会等到用户发现。
 *   3. 一句说明只讲"看得见的行为"，不讲历史与人名。
 */

export type PatternGroup = 'still' | 'oscillator' | 'spaceship' | 'methuselah' | 'gun'

/** 分组的显示名与顺序（顺序就是面板里的顺序，学习路径：不动 → 动而不走 → 走 → 长 → 造） */
export const GROUPS: { id: PatternGroup; name: string }[] = [
  { id: 'still', name: '静止体' },
  { id: 'oscillator', name: '振荡器' },
  { id: 'spaceship', name: '飞船' },
  { id: 'methuselah', name: '长寿种子' },
  { id: 'gun', name: '机枪' }
]

export interface Pattern extends Shape {
  /** 稳定 id，写进用例与册子 */
  id: string
  /** 中文名 */
  name: string
  group: PatternGroup
  /** 一句说明：只能念得出界面上真看得见的行为 */
  note: string
  /**
   * 落点。默认居中；机枪这类要"往一个方向走很久"的图形落在左上，
   * 不然滑翔机刚出门就撞边界，学习者看到的是墙不是枪。
   */
  anchor?: 'center' | 'top-left'
}

export const PATTERNS: Pattern[] = [
  {
    id: 'block',
    name: '方块',
    group: 'still',
    rows: ['##', '##'],
    note: '四格 2×2，一代一代原样不动'
  },
  {
    id: 'boat',
    name: '小船',
    group: 'still',
    rows: ['##.', '#.#', '.#.'],
    note: '五格，歪的，也一动不动'
  },
  {
    id: 'beehive',
    name: '蜂房',
    group: 'still',
    rows: ['.##.', '#..#', '.##.'],
    note: '六格围成一圈，一动不动'
  },
  {
    id: 'loaf',
    name: '面包',
    group: 'still',
    rows: ['.##.', '#..#', '#.#.', '.#..'],
    note: '七格，比蜂房更歪，照样一动不动'
  },
  {
    id: 'blinker',
    name: '闪烁灯',
    group: 'oscillator',
    rows: ['###'],
    note: '三格，横一下竖一下，2 代一个循环'
  },
  {
    id: 'toad',
    name: '蟾蜍',
    group: 'oscillator',
    rows: ['.###', '###.'],
    note: '两排错开，2 代里翻一次面'
  },
  {
    id: 'beacon',
    name: '信标',
    group: 'oscillator',
    rows: ['##..', '##..', '..##', '..##'],
    note: '两颗方块对角错两格，一张一合，2 代一个循环'
  },
  {
    id: 'pulsar',
    name: '脉冲星',
    group: 'oscillator',
    rows: [
      '..###...###..',
      '.............',
      '#....#.#....#',
      '#....#.#....#',
      '#....#.#....#',
      '..###...###..',
      '.............',
      '..###...###..',
      '#....#.#....#',
      '#....#.#....#',
      '#....#.#....#',
      '.............',
      '..###...###..'
    ],
    note: '48 格的对称花，活格数按 48 → 56 → 72 循环，3 代一轮'
  },
  {
    id: 'pentadecathlon',
    name: '十五棒',
    group: 'oscillator',
    rows: ['..#....#..', '##.####.##', '..#....#..'],
    note: '一根长条憋两下才放开，15 代才回到原样'
  },
  {
    id: 'glider',
    name: '滑翔机',
    group: 'spaceship',
    rows: ['.#.', '..#', '###'],
    note: '五格，最小的飞船，每 4 代往右下挪一格'
  },
  {
    id: 'lwss',
    name: '轻量飞船',
    group: 'spaceship',
    rows: ['#..#.', '....#', '#...#', '.####'],
    note: '九格，往前推得比滑翔机快，每 4 代向右走两格'
  },
  {
    id: 'r-pentomino',
    name: 'R 五连块',
    group: 'methuselah',
    rows: ['.##', '##.', '.#.'],
    note: '五个格的种子，跑到第 200 代还在变，边界上会撞碎一片'
  },
  {
    id: 'acorn',
    name: '橡果',
    group: 'methuselah',
    rows: ['.#.....', '...#...', '##..###'],
    note: '七个格，散出一堆滑翔机，第 300 代还没安定'
  },
  {
    id: 'diehard',
    name: '挣扎者',
    group: 'methuselah',
    rows: ['......#.', '##......', '.#...###'],
    note: '挣扎到第 130 代，一个不剩'
  },
  {
    id: 'gosper-gun',
    name: '高斯帕滑翔机枪',
    group: 'gun',
    rows: [
      '........................#...........',
      '......................#.#...........',
      '............##......##............##',
      '...........#...#....##............##',
      '##........#.....#...##..............',
      '##........#...#.##....#.#...........',
      '..........#.....#.......#...........',
      '...........#...#....................',
      '............##......................'
    ],
    note: '36 格的机器，每 30 代吐出一只滑翔机',
    anchor: 'top-left'
  }
]

/** 按 id 取图形；取不到返回 null（界面不猜） */
export function patternById(id: string): Pattern | null {
  return PATTERNS.find((p) => p.id === id) ?? null
}

/** 某个分组下的图形，按库里的顺序 */
export function patternsOf(group: PatternGroup): Pattern[] {
  return PATTERNS.filter((p) => p.group === group)
}

/**
 * 放下去时它的左上角落在哪一格。
 *
 * 默认外框居中；`anchor: 'top-left'` 的那几个（机枪）贴着左上角放，
 * 因为它造出来的滑翔机要一路往右下走，居中就意味着刚出门就撞墙——
 * 学习者该看到的是"枪在吐"，不是"墙"。
 * 这条算在数据这一层，界面与用例才拿得到同一个落点（LF-019）。
 */
export function patternPlacement(pattern: Pattern, n: number): { x: number; y: number } {
  return pattern.anchor === 'top-left' ? { x: 1, y: 1 } : centeredAt(n, pattern)
}
