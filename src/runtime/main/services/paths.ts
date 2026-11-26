import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { SHARED_NAMESPACES, pathEscape, type AppId, type SharedNamespace } from '@airship/contract'

/**
 * 目录布局（全部在 Electron 的 userData 下）：
 *
 *   userData/
 *     logs/airship-YYYY-MM-DD.log
 *     icons/<id>.ico                 交给 Windows 外壳的任务栏图标（包内那份 icon.ico 的落盘）
 *     shared/library/              runtime 级共享区：books 与 pdf 共用的书库
 *     apps/<appId>/settings.json   应用私有设置（含它自己的主题档）
 *     apps/<appId>/data/           应用私有数据
 *     apps/<appId>/cache/          可随时整体删除重建
 *
 * **每个应用的目录是按 id 现算的，不是启动时的一张快照。**
 * 这条是踩过来的：原来 `build()` 会遍历当时的注册表建一张 `apps` 表并缓存，
 * 于是拖放装进来的应用——注册表重扫了、这张表没重扫——第一次读写自己的数据就撞在
 * `Cannot read properties of undefined (reading 'data')` 上：格子里看得见、点得开，
 * 一开机就读失败。目录布局只依赖 userData 根与 id，本来就不需要知道"现在有哪些应用"。
 * 顺带也断了 `paths → appRegistry → logging → paths` 这个环。
 */

interface AppDirs {
  data: string
  cache: string
  settings: string
}

let cached: { root: string; logs: string; shared: Record<string, string> } | null = null

function build() {
  const root = app.getPath('userData')
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })

  const shared: Record<string, string> = {}
  for (const ns of SHARED_NAMESPACES) {
    const dir = join(root, 'shared', ns)
    mkdirSync(dir, { recursive: true })
    shared[ns] = dir
  }

  return { root, logs, shared }
}

export function paths() {
  if (!cached) cached = build()
  return cached
}

/**
 * 这个应用在 userData 下的那一族的根：`<userData>/apps/<id>`，里面是 data、cache、settings.json。
 *
 * 与下面 `dirsFor` 的区别是**它不建目录**：卸载要问的是"这一族在不在"，
 * 不是"给我用一下"——用 appDataDir 去问会顺手把 data 与 cache 造出来，
 * 于是"没开过窗口的应用"被卸成"删过数据的应用"，界面上那句就念错了。
 */
export function appBaseDir(id: AppId): string {
  return join(paths().root, 'apps', id)
}

/** 这个应用的三个目录；不存在就地建。所以"什么时候装的包"不影响它能不能用 */
function dirsFor(id: AppId): AppDirs {
  const base = appBaseDir(id)
  const data = join(base, 'data')
  const cache = join(base, 'cache')
  mkdirSync(data, { recursive: true })
  mkdirSync(cache, { recursive: true })
  return { data, cache, settings: join(base, 'settings.json') }
}

export function appDataDir(id: AppId): string {
  return dirsFor(id).data
}

export function appCacheDir(id: AppId): string {
  return dirsFor(id).cache
}

export function appSettingsFile(id: AppId): string {
  return dirsFor(id).settings
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

export function logDir(): string {
  return paths().logs
}

/**
 * 外壳（任务栏按钮）用的那张图落在哪里：`<userData>/icons/<id>.ico`。
 *
 * 为什么要在磁盘上另放一份：Windows 外壳读图标只认文件系统路径，既不认 asar，
 * 也不认 `airship://`——包根那份 `icon.ico`（PK-036，随源图一起备好的那一份）必须由 runtime 摊平了交出去。
 * 这份是**包内那份的落盘副本**，不是应用数据：重装或重产包后按包内字节覆盖，删了也只是回落成 runtime 的样子。
 */
export function taskbarIconFile(id: AppId): string {
  const dir = join(paths().root, 'icons')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.ico`)
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
