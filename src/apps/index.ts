import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import type { AppMeta } from '@shared/app'
import type { AppApi } from '@shared/protocol'

/**
 * 应用发现。
 *
 * 这是整个约定里唯一需要"知道有哪些应用"的地方，而它不写名单：
 * 两个 glob 分别抓各应用目录里的 `app.ts`（纯数据清单）和 `index.tsx`（组件入口），
 * 按目录名对上。**加一个应用 = 加一个目录，这个文件不用改。**
 *
 * 组件走 lazy：每个应用一个 chunk，也顺手为将来"按清单动态加载"留好了形状。
 */

const metaModules = import.meta.glob<{ app: AppMeta }>('./*/app.ts', { eager: true })
const componentModules = import.meta.glob<{ default: ComponentType<{ api: AppApi }> }>('./*/index.tsx')

export interface AppEntry {
  meta: AppMeta
  component: LazyExoticComponent<ComponentType<{ api: AppApi }>>
  /** 内容区去掉壳给默认内边距 */
  flush: boolean
  /** 原始加载器：宿主在截图模式下要等它 resolve 完才报就绪 */
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
  const entryPath = `./${id}/index.tsx`
  const loader = componentModules[entryPath]
  if (!loader) {
    problems.push(`${id}: 缺组件入口 ${entryPath}`)
    continue
  }
  collected.push({
    meta,
    component: lazy(loader),
    flush: meta.flush === true,
    load: loader
  })
}

if (problems.length > 0) {
  // 清单不完整就炸，别让一个"注册了一半"的应用悄悄出现在侧栏里点不开
  throw new Error(`应用注册失败：\n${problems.join('\n')}`)
}

// 显示顺序由应用自己在清单里定（order），没写就按名字排；
// 壳不维护顺序表，否则又变成"加应用要改壳"
collected.sort((a, b) => (a.meta.order ?? 1000) - (b.meta.order ?? 1000) || a.meta.name.localeCompare(b.meta.name, 'zh'))

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
