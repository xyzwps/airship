import type { RawContainer, RawImage } from './parse'

/**
 * 状态映射与展示文案。
 *
 * 这一层只做一件事：把 wslc 报回来的字段翻译成人读的话。
 * 判定规矩都来自实测——比如 `State` 的大小写不保证一致、`<none>` 不是仓库名而是"没有标签"。
 */

export const DASH = '—'

export const dash = (value: string | null | undefined): string => {
  const text = (value ?? '').trim()
  return text.length === 0 ? DASH : text
}

/* ---------------- 容器 ---------------- */

/** `State` 为 running（不区分大小写）才算运行中 */
export const isRunning = (state: string): boolean => state.trim().toLowerCase() === 'running'

/** `Names` 可能是逗号分隔的别名列表：取第一个，并去掉 docker 风格的前导 `/` */
export function containerName(names: string): string {
  const first = names
    .split(',')
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return (first ?? '').replace(/^\/+/, '')
}

export const containerLabel = (container: RawContainer): string =>
  containerName(container.names) || container.id

export const stateLabel = (container: RawContainer): string =>
  isRunning(container.state) ? '运行中' : '已停止'

/** 运行中的在前，同档内按名称排（不区分大小写） */
export function sortContainers(list: readonly RawContainer[]): RawContainer[] {
  return [...list].sort((a, b) => {
    const rank = Number(isRunning(a.state)) - Number(isRunning(b.state))
    if (rank !== 0) return -rank
    return containerLabel(a).localeCompare(containerLabel(b), 'zh', { sensitivity: 'base' })
  })
}

/** 搜索只在已经读回来的数据里挑：名称、镜像、ID 的任一片段，不区分大小写、不要求从头 */
export function containerMatches(container: RawContainer, needle: string): boolean {
  const want = needle.trim().toLowerCase()
  if (want.length === 0) return true
  return [containerLabel(container), container.image, container.id].some(
    (field) => field.toLowerCase().includes(want)
  )
}

/** 汇总说的是全机，不是眼前这几行 */
export const containersSummary = (list: readonly RawContainer[]): string =>
  `共 ${list.length} 个容器 · ${list.filter((c) => isRunning(c.state)).length} 个运行中`

export const platformText = (container: RawContainer): string => {
  const parts = [container.platformOs, container.platformArch].map((p) => p.trim()).filter((p) => p.length > 0)
  return parts.length === 0 ? '' : parts.join(' / ')
}

export interface DetailField {
  label: string
  value: string
}

export interface DetailSection {
  title: string
  fields: DetailField[]
}

/** 详情那几节：字段一个都不落在列表里，没有值的摆成横杠 */
export function containerSections(container: RawContainer): DetailSection[] {
  return [
    {
      title: '基本信息',
      fields: [
        { label: 'ID', value: dash(container.id) },
        { label: '镜像', value: dash(container.image) },
        { label: '命令', value: dash(container.command) },
        { label: '创建时间', value: dash(container.createdAt) },
        { label: '平台', value: dash(platformText(container)) },
        { label: '大小', value: dash(container.size) }
      ]
    },
    {
      title: '运行状态',
      fields: [
        { label: '状态', value: dash(container.state) },
        { label: '状态详情', value: dash(container.status) },
        { label: '健康检查', value: dash(container.health) }
      ]
    },
    {
      title: '网络',
      fields: [
        { label: '端口', value: dash(container.ports) },
        { label: '网络', value: dash(container.networks) }
      ]
    }
  ]
}

/* ---------------- 镜像 ---------------- */

/** 空、`<none>`、`<null>`、`-` 都不算真值 */
function isPlaceholder(value: string): boolean {
  const text = value.trim()
  return text.length === 0 || text === '<none>' || text === '<null>' || text === '-'
}

/** wslc 用字符串表示引用它的容器数量；认不出来就按没人用说 */
export function imageContainerCount(image: RawImage): number {
  const raw = image.containers.trim()
  if (!/^\d+$/.test(raw)) return 0
  return Math.max(0, Number.parseInt(raw, 10))
}

export const imageInUse = (image: RawImage): boolean => imageContainerCount(image) > 0

/** 有真实仓库名才算"有标签" */
export const imageIsTagged = (image: RawImage): boolean => !isPlaceholder(image.repository)

const imageTagText = (image: RawImage): string => (isPlaceholder(image.tag) ? '' : image.tag.trim())

/** 主标题用的引用；无标签镜像退化成镜像 ID */
export function imageReference(image: RawImage): string {
  if (!imageIsTagged(image)) return image.id
  const tag = imageTagText(image)
  const repo = image.repository.trim()
  return tag.length === 0 ? repo : `${repo}:${tag}`
}

export const imageDisplayName = (image: RawImage): string =>
  imageIsTagged(image) ? imageReference(image) : `无标签 · ${imageShortId(image)}`

export const imageShortId = (image: RawImage): string => image.id.slice(0, 12)

export const imageSizeText = (image: RawImage): string => dash(image.size)

export const imageUsageText = (image: RawImage): string =>
  imageInUse(image) ? `被 ${imageContainerCount(image)} 个容器引用` : '未被容器引用'

const CREATED_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:\s*(?:GMT|UTC)?([+-]\d{2}):?(\d{2}))?/

const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

/**
 * 创建时间：wslc 写的是 `2026-05-13 10:21:49 +0800 GMT+8`，
 * 末尾那个时区名会让通用解析器犯糊涂，所以自己拆字段算成本地时刻。
 * 认不出来就退回相对时间，再不行原样显示——不留空白也不报错。
 */
export function imageCreatedText(image: RawImage): string {
  const raw = image.createdAt.trim()
  const hit = CREATED_RE.exec(raw)
  if (hit) {
    const offsetMinutes = hit[7] ? Number(hit[7]) * 60 + Number(hit[8] ?? '0') : 0
    const stamp =
      Date.UTC(
        Number(hit[1]),
        Number(hit[2]) - 1,
        Number(hit[3]),
        Number(hit[4]),
        Number(hit[5]),
        Number(hit[6])
      ) - offsetMinutes * 60_000
    const at = new Date(stamp)
    return `${pad(at.getFullYear(), 4)}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  const since = image.createdSince.trim()
  return since.length > 0 ? since : dash(raw)
}

export function imageSubtleLine(image: RawImage): string {
  const base = `ID ${imageShortId(image)} · 创建 ${imageCreatedText(image)}`
  return isPlaceholder(image.digest) ? base : `${base} · 摘要 ${image.digest.trim()}`
}

/** 被引用的在前，其次仓库名、再标签，都不区分大小写 */
export function sortImages(list: readonly RawImage[]): RawImage[] {
  return [...list].sort((a, b) => {
    const rank = Number(imageInUse(a)) - Number(imageInUse(b))
    if (rank !== 0) return -rank
    const repo = a.repository.localeCompare(b.repository, 'zh', { sensitivity: 'base' })
    if (repo !== 0) return repo
    return imageTagText(a).localeCompare(imageTagText(b), 'zh', { sensitivity: 'base' })
  })
}

export function imageMatches(image: RawImage, needle: string): boolean {
  const want = needle.trim().toLowerCase()
  if (want.length === 0) return true
  return [image.repository, image.tag, image.id].some((field) => field.toLowerCase().includes(want))
}

export function imagesSummary(list: readonly RawImage[]): string {
  if (list.length === 0) return '本机还没有镜像'
  const tagged = list.filter(imageIsTagged).length
  const inUse = list.filter(imageInUse).length
  return `共 ${list.length} 个镜像 · ${tagged} 个有标签 · ${inUse} 个正被容器引用`
}

/* ---------------- 时刻 ---------------- */

export const NEVER_REFRESHED = '尚未刷新'

/** "最近刷新"精确到秒 */
export function clockOfDay(at: number): string {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
