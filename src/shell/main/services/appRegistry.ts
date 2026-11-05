import type { AppMeta } from '@shared/app'
import { platformIssue } from '@shared/errors'
import { manifestProblems } from '@shared/registryRules'
import type { Capability, PlatformId, SharedNamespace, ToolName } from '@shared/protocol'

/**
 * 主进程侧的应用注册表。
 *
 * 和渲染侧的 apps/index.ts 抓的是同一批清单文件（apps/<id>/app.ts，纯数据），
 * 所以"有哪些应用、各自声明了什么"在两侧是**同一个真源**，不存在两份名单对不齐的问题。
 *
 * 主进程必须自己知道这张表：能力校验要在主进程做，
 * 如果由渲染侧把能力传过来，那等于没有校验。
 *
 * 清单里只有数据没有组件，所以主进程 import 它不会把渲染侧代码拖进来。
 */

const modules = import.meta.glob<{ app: AppMeta }>('../../../apps/*/app.ts', {
  eager: true
})

function idOfPath(path: string): string {
  const m = /\/([^/]+)\/app\.ts$/.exec(path)
  return m?.[1] ?? ''
}

const collected = new Map<string, AppMeta>()
const problems: string[] = []

for (const [path, mod] of Object.entries(modules)) {
  const dirId = idOfPath(path)
  const issues = manifestProblems(path, dirId, mod.app, [...collected.keys()])
  if (issues.length > 0) {
    problems.push(...issues)
    continue
  }
  collected.set(mod.app!.id, mod.app!)
}

if (problems.length > 0) {
  // 启动就炸，比运行到一半"能力查不到"好解释得多
  throw new Error(`应用注册表构建失败：\n${problems.join('\n')}`)
}

export const APP_MAP: ReadonlyMap<string, AppMeta> = collected

export function appIds(): string[] {
  return [...collected.keys()]
}

/** 按名字典序排好的元数据；顺序是壳的表现决定，不由应用自己声明 */
export function appsInOrder(): AppMeta[] {
  return [...collected.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export function isKnownApp(value: unknown): value is string {
  return typeof value === 'string' && collected.has(value)
}

export function capabilitiesOf(app: string): readonly Capability[] {
  return collected.get(app)?.capabilities ?? []
}

export function hasCapability(app: string, capability: Capability): boolean {
  return capabilitiesOf(app).includes(capability)
}

/** 应用能不能碰某个共享命名空间：既要有 shared 能力，也要在名单里 */
export function canAccessShared(app: string, ns: string): ns is SharedNamespace {
  if (!hasCapability(app, 'shared')) return false
  const meta = collected.get(app)
  return (meta?.sharedNamespaces ?? []).includes(ns as SharedNamespace)
}

/** 本应用声明的共享命名空间 */
export function sharedNamespacesOf(app: string): SharedNamespace[] {
  return collected.get(app)?.sharedNamespaces ?? []
}

/** 本应用声明要用的外部工具 */
export function toolsOf(app: string): ToolName[] {
  return collected.get(app)?.tools ?? []
}

/**
 * 应用能不能问壳要这个工具的路径：
 * 既要有 proc 能力（拿到路径是为了跑它），也要在清单 tools 里声明过（可审计）。
 */
export function canUseTool(app: string, tool: ToolName): boolean {
  return hasCapability(app, 'proc') && toolsOf(app).includes(tool)
}

/** 这个应用在当前平台上用不了的话，原因是什么；能用则 null */
export function unavailableReason(app: string, platform: PlatformId | 'unknown'): string | null {
  const meta = collected.get(app)
  return meta ? platformIssue(meta, platform) : null
}

export function availableOn(app: string, platform: PlatformId | 'unknown'): boolean {
  return unavailableReason(app, platform) === null
}

/** 当前平台用得了的应用，按名字典序（启动器与截图工装都按这个顺序摆） */
export function appsAvailableOn(platform: PlatformId | 'unknown'): AppMeta[] {
  return appsInOrder().filter((meta) => availableOn(meta.id, platform))
}
