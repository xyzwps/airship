import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { AppMeta } from '@shared/app'
import type { AppApi } from '@shared/protocol'

/**
 * 应用发现。
 *
 * 这是整个约定里唯一需要"知道有哪些应用"的地方，而它不写名单：
 * 三个 glob 分别抓各应用目录里的
 *   app.ts                        纯数据清单（急切；主进程也抓同一批，两侧同一个真源）
 *   icon.svg|png|jpg|jpeg|webp    图标文件（急切；启动器不打开应用也得能画出来）
 *   index.tsx                     应用组件（懒；每个应用一个 chunk）
 *
 * **加一个应用 = 加一个目录，这个文件不用改。**
 *
 * 图标是文件而不是组件：约定就是"往应用目录扔一张 icon.svg"，
 * 壳不假定它的内部结构（几条 path、circle、渐变、位图都随应用便）。
 * 代价是文件图标拿不到 currentColor，颜色得烘进图里——
 * 所以清单里的 accent 只用于图标底板的掺色，两处颜色各自成立。
 */

const metaModules = import.meta.glob<{ app: AppMeta }>('./*/app.ts', { eager: true })
const iconModules = import.meta.glob<string>('./*/icon.{svg,png,jpg,jpeg,webp}', {
  eager: true,
  query: '?url',
  import: 'default'
})
const componentModules = import.meta.glob<{ default: ComponentType<{ api: AppApi }> }>('./*/index.tsx')

export interface AppEntry {
  meta: AppMeta
  component: LazyExoticComponent<ComponentType<{ api: AppApi }>>
  /** 图标的资源 URL，由 Vite 打包后给出 */
  iconUrl: string
  /** 内容区去掉壳给的默认内边距 */
  flush: boolean
  /** 组件的原始加载器：宿主在截图模式下要等它 resolve 完才报就绪 */
  load: () => Promise<{ default: ComponentType<{ api: AppApi }> }>
}

/** 从 './vcp/app.ts' 里取出 'vcp' */
function idOfPath(path: string): string {
  const m = /^\.\/([^/]+)\//.exec(path)
  return m?.[1] ?? ''
}

const collected: AppEntry[] = []
const problems: string[] = []

for (const [path, mod] of Object.entries(metaModules)) {
  const id = idOfPath(path)
  const meta = mod.app
  if (!meta || meta.id !== id) {
    // 目录名和清单 id 必须一致：数据目录、能力校验、组件解析全靠这个对应关系
    problems.push(`${path}: 清单 id "${meta?.id ?? '(缺失)'}" 与目录名 "${id}" 不一致`)
    continue
  }

  // 图标：一个应用只该有一张，多了不知道用哪个
  const iconKeys = Object.keys(iconModules).filter((k) => k.startsWith(`./${id}/icon.`))
  if (iconKeys.length === 0) {
    problems.push(`${id}: 缺图标 apps/${id}/icon.svg（也接受 png / jpg / jpeg / webp）`)
    continue
  }
  if (iconKeys.length > 1) {
    problems.push(`${id}: 图标有多张，只留一张：${iconKeys.join(', ')}`)
    continue
  }

  const loader = componentModules[`./${id}/index.tsx`]
  if (!loader) {
    problems.push(`${id}: 缺组件入口 ./apps/${id}/index.tsx`)
    continue
  }

  collected.push({
    meta,
    iconUrl: iconModules[iconKeys[0]!]!,
    component: lazy(loader),
    flush: meta.flush === true,
    load: loader
  })
}

if (problems.length > 0) {
  // 清单不完整就炸，别让一个"注册了一半"的应用悄悄出现在格子里点不开
  throw new Error(`应用注册失败：\n${problems.join('\n')}`)
}

// 显示顺序由壳按名字典序定。清单里不放 order 字段：
// 顺序是应用之间的关系，任何单个应用都不可能"自己决定"自己的排位——
// 它写 1 还是 2 全靠知道别人写了什么，那正是我们要拆的耦合。
collected.sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'zh'))

export const APPS: AppMeta[] = collected.map((e) => e.meta)

export const APP_ENTRIES: Record<string, AppEntry> = Object.fromEntries(
  collected.map((e) => [e.meta.id, e])
)

export const APP_MAP: Record<string, AppMeta> = Object.fromEntries(
  collected.map((e) => [e.meta.id, e.meta])
)

export function isKnownApp(value: string | null | undefined): value is string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APP_MAP, value)
}

/** 应用宿主按 id 取入口；取不到就是没注册 */
export function entryFor(id: string): AppEntry | null {
  return APP_ENTRIES[id] ?? null
}
