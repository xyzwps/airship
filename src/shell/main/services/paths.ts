import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SHARED_NAMESPACES, type AppId, type SharedNamespace } from '@shared/protocol'
import { pathEscape } from '@shared/errors'
import { appIds } from './appRegistry'

/**
 * 目录布局（全部在 Electron 的 userData 下）：
 *
 *   userData/
 *     settings.json                壳级设置（主题、最近应用、窗口状态、ffmpeg 路径）
 *     logs/airship-YYYY-MM-DD.log
 *     shared/library/              壳级共享区：books 与 pdf 共用的书库
 *     apps/<appId>/settings.json   应用私有设置
 *     apps/<appId>/data/           应用私有数据
 *     apps/<appId>/cache/          可随时整体删除重建
 */

interface AppDirs {
  data: string
  cache: string
  settings: string
}

let cached: {
  root: string
  logs: string
  apps: Record<string, AppDirs>
  shared: Record<string, string>
} | null = null

function build() {
  const root = app.getPath('userData')
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })

  const apps: Record<string, AppDirs> = {}
  for (const id of appIds()) {
    const base = join(root, 'apps', id)
    const data = join(base, 'data')
    const cache = join(base, 'cache')
    mkdirSync(data, { recursive: true })
    mkdirSync(cache, { recursive: true })
    apps[id] = { data, cache, settings: join(base, 'settings.json') }
  }

  const shared: Record<string, string> = {}
  for (const ns of SHARED_NAMESPACES) {
    const dir = join(root, 'shared', ns)
    mkdirSync(dir, { recursive: true })
    shared[ns] = dir
  }

  return { root, logs, apps, shared }
}

export function paths() {
  if (!cached) cached = build()
  return cached
}

export function appDataDir(id: AppId): string {
  return paths().apps[id]!.data
}

export function appCacheDir(id: AppId): string {
  return paths().apps[id]!.cache
}

export function appSettingsFile(id: AppId): string {
  return paths().apps[id]!.settings
}

export function sharedDir(ns: SharedNamespace): string {
  return paths().shared[ns]!
}

/** 本应用有权访问的共享命名空间目录表 */
export function sharedDirsFor(namespaces: readonly SharedNamespace[]): Partial<Record<SharedNamespace, string>> {
  const out: Partial<Record<SharedNamespace, string>> = {}
  for (const ns of namespaces) out[ns] = sharedDir(ns)
  return out
}

export function shellSettingsFile(): string {
  return join(paths().root, 'settings.json')
}

export function logDir(): string {
  return paths().logs
}

/** 把若干段拼到应用数据目录下，并挡住 ../ 越界 */
export function resolveInData(id: AppId, segments: string[]): string {
  return resolveUnder(appDataDir(id), segments, `${id} 的数据目录`)
}

/** 把若干段拼到共享命名空间目录下，同样挡住越界 */
export function resolveInShared(ns: SharedNamespace, segments: string[]): string {
  return resolveUnder(sharedDir(ns), segments, `共享命名空间 ${ns}`)
}

function resolveUnder(base: string, segments: string[], label: string): string {
  const target = join(base, ...segments)
  if (!isInside(base, target)) {
    throw new Error(pathEscape(segments, label))
  }
  return target
}

export function isInside(base: string, target: string): boolean {
  const b = normalize(base)
  const t = normalize(target)
  return t === b || t.startsWith(b.endsWith('\\') ? b : b + '\\')
}

/** Windows 上大小写不敏感，统一小写比较；同时把 / 归一成 \ */
function normalize(p: string): string {
  const s = p.replace(/\//g, '\\')
  return process.platform === 'win32' ? s.toLowerCase() : s
}
