import type { AppMeta } from './app.ts'
import { APP_ID_PATTERN } from './app.ts'
import { badAppId } from './errors.ts'

/**
 * 一个 airship 包的形状规矩（契约见 `src/apps/specs/package.md`）。
 *
 * 这份文件是**唯一的一份实现**：runtime 注册期调它，产包器（`@airship/cli`，仓库内的 `code/pack-app.mjs`
 * 是它的薄适配）也调它。从前两侧各写一份是因为 Node 解不开本仓的 TS，由用例把两份钉成相等；
 * 现在 contract 编译成 dist 的 JS，Node 装的就是这一份——"两侧逐字相同"从用例承诺变成了结构保证。
 * 带 `at` 的函数在原因前面拼"位置: "；产包侧传空串就得到不带头部的那份原话。
 */

/** 包目录名的后缀：`<id>` + 这个 */
export const PACKAGE_SUFFIX = '.airship'

/** 包清单的文件名，在包根 */
export const MANIFEST_NAME = 'manifest.json'

/** runtime 只认这一档包格式 */
export const SCHEMA_VERSION = 1

/** 入口文档的默认名字（清单不写 entry 就是它） */
export const DEFAULT_ENTRY = 'index.html'

/** 图标仍是文件约定，不进清单 */
export const ICON_PATTERN = /^icon\.(svg|png|jpe?g|webp)$/

/**
 * 包根那份 Windows 外壳图标（PK-036）。
 *
 * 它不是第二张图标：外壳（任务栏按钮、固定到任务栏那颗）只读磁盘上的 `.ico`，
 * 不认归档里的路径，也不认包内那张源图的格式。仓库内产包时由包根那张源图派生
 * （resvg + Pillow，见 `code/pack-app.mjs`）；仓库外由作者自备（PK-039），两处都只有产包器写它。
 */
export const WINDOWS_ICON_NAME = 'icon.ico'

/**
 * 后台入口的文件名后缀（PK-037）。
 *
 * utilityProcess.fork 吃的是真文件；runtime 会把这个条目从归档里解到磁盘再 fork，
 * 所以只认 Node 直接跑得起来的三档扩展名——`.ts` 之类要先编译的不在包格式里许诺。
 */
export const BACKEND_ENTRY_PATTERN = /\.(js|mjs|cjs)$/

/** 包清单允许的键 */
export const ALLOWED_KEYS = [
  'id',
  'name',
  'description',
  'capabilities',
  'sharedNamespaces',
  'flush',
  'defaultWidth',
  'defaultHeight',
  'platforms',
  'tools',
  'backend',
  'schemaVersion',
  'sdkVersion',
  'entry'
] as const

/** 被明确驳回过的表现字段（与 AP-007 同一理由） */
export const REJECTED_KEYS = ['iconPath', 'icon', 'order'] as const

/** 包清单 = 应用清单 + 包格式的三个字段 */
export interface PackageManifest extends AppMeta {
  schemaVersion: number
  sdkVersion: string
  entry?: string
}

/** 一级目录名是不是一个包（暂存与备份目录都不是，见 PK-007） */
export function isPackageDir(name: string): boolean {
  return name.endsWith(PACKAGE_SUFFIX)
}

/** 从包目录名取 id：`life.airship` → `life` */
export function idOfPackageDir(name: string): string {
  return name.slice(0, -PACKAGE_SUFFIX.length)
}

/** 这份清单要加载哪个入口文档 */
export function entryOf(manifest: PackageManifest): string {
  return typeof manifest.entry === 'string' && manifest.entry !== '' ? manifest.entry : DEFAULT_ENTRY
}

/**
 * 包内相对路径的判据：不许以 `/` 开头、不许含 `..` 段、不许有 Windows 或 URL 里带语义的字符。
 * 入口名会被拼进 `airship://<id>/<entry>` 与磁盘路径，这两侧都经不起越界。
 */
export function isInsidePackagePath(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/[<>:"|?*%#]/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

/**
 * PK-001：id 的形状。返回值是要给人读的那一句，合格返回 null。
 *
 * 为什么只挡这一批字符：实测下来 id 进 URL 段与进 Windows 目录名，会坏的就四类——
 * `#`/`?` 截断、`%` 让校验值与落盘值分叉、NTFS 非法字符、空白；全小写顺带把大小写折叠的撞名也消掉了。
 * 那句话的正文住在 `badAppId`（errors.ts），这里只判。
 */
export function idShapeProblem(id: unknown): string | null {
  if (typeof id !== 'string' || id === '') return '包清单缺 id，或 id 不是字符串'
  return APP_ID_PATTERN.test(id) ? null : badAppId(id)
}

/**
 * 包清单的形状判定。返回**人读的原因列表**，空数组就是通过。
 *
 * 不判能力名与工具名——那两条住在 `manifestProblems()`（app.ts 与包清单共用的那份），
 * 注册期两边都调；这里判的是包格式独有的那一圈。
 */
export function packageManifestProblems(manifest: unknown, at = ''): string[] {
  const p = at ? `${at}: ` : ''
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [`${p}包清单必须是一个 JSON 对象`]
  }
  const m = manifest as Record<string, unknown>
  const out: string[] = []

  const idProblem = idShapeProblem(m.id)
  if (idProblem) out.push(`${p}${idProblem}`)

  if (m.schemaVersion !== SCHEMA_VERSION) {
    out.push(
      `${p}包清单 schemaVersion 只认 ${SCHEMA_VERSION}，收到 ${JSON.stringify(m.schemaVersion)}` +
        `（包格式与 runtime 不同档时别硬装，先对齐 runtime 的版本）`
    )
  }
  if (typeof m.sdkVersion !== 'string' || m.sdkVersion.trim() === '') {
    out.push(`${p}包清单缺 sdkVersion：写构建这个包时用的 SDK 版本，例如 "1.0.0"`)
  }
  for (const key of ['name', 'description'] as const) {
    const v = m[key]
    if (typeof v !== 'string' || v.trim() === '') {
      out.push(`${p}包清单 ${key} 必须是非空字符串，收到 ${JSON.stringify(v)}`)
    }
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== 'string')) {
    out.push(`${p}包清单 capabilities 必须是字符串数组，用不到就写空数组`)
  }
  if (m.entry !== undefined && typeof m.entry !== 'string') {
    out.push(
      `${p}包清单 entry 不写就等于 ${DEFAULT_ENTRY}，写了必须是字符串，收到 ${JSON.stringify(m.entry)}`
    )
  }
  if (typeof m.entry === 'string' && m.entry !== '' && !isInsidePackagePath(m.entry)) {
    out.push(`${p}包清单 entry 必须是包内的相对路径，收到 ${JSON.stringify(m.entry)}`)
  }
  if (m.backend !== undefined && (typeof m.backend !== 'string' || m.backend.trim() === '')) {
    out.push(`${p}包清单 backend 不写就等于没有后台，写了必须是包内后端入口的相对路径，收到 ${JSON.stringify(m.backend)}`)
  }
  if (typeof m.backend === 'string' && m.backend !== '' && (!isInsidePackagePath(m.backend) || !BACKEND_ENTRY_PATTERN.test(m.backend))) {
    out.push(`${p}包清单 backend 必须是包内的相对路径，以 .js / .mjs / .cjs 结尾，收到 ${JSON.stringify(m.backend)}`)
  }
  for (const key of ['defaultWidth', 'defaultHeight'] as const) {
    const v = m[key]
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      out.push(`${p}包清单 ${key} 必须是正整数像素值，收到 ${JSON.stringify(v)}`)
    }
  }
  for (const key of REJECTED_KEYS) {
    if (key in m) {
      out.push(
        `${p}包清单里不写 ${key}：图标是包根那一张文件（icon.svg / png / jpg / jpeg / webp），` +
          `显示顺序由 runtime 按名字典序定，两者都不是应用自己能决定的`
      )
    }
  }
  for (const key of Object.keys(m)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      out.push(`${p}包清单有 runtime 不认的键 "${key}"（要么拼错，要么包格式与 runtime 不同档）`)
    }
  }
  return out
}

/**
 * 包根那层唯一的图标（PK-004）。只看根：条目名里没有斜杠的才算
 * （assets/icon.svg 那种是应用自己的素材）。缺与多都返回那句人读的原因。
 */
export function rootIconName(entryNames: readonly string[]): { name?: string; error?: string } {
  const icons = entryNames.filter((n) => !n.includes('/') && ICON_PATTERN.test(n))
  if (icons.length === 0) return { error: '包里缺图标 icon.svg（也接受 png / jpg / jpeg / webp），一张都要有' }
  if (icons.length > 1) return { error: `包里的图标有多张，只留一张：${icons.join(', ')}` }
  return { name: icons[0]! }
}

/**
 * 清单点名的文件在不在包里（PK-004 落盘版与 PK-038）：入口、图标、后端入口各念一句原话。
 *
 * 产包侧喂产物目录的文件名，注册侧喂归档条目名——同一份判据，两侧不可能说岔。
 */
export function packageLayoutProblems(manifest: PackageManifest, entryNames: readonly string[], at = ''): string[] {
  const p = at ? `${at}: ` : ''
  const out: string[] = []
  if (!entryNames.includes(entryOf(manifest))) {
    out.push(`${p}包里没有入口文件 ${entryOf(manifest)}（清单 entry 指的就是它在包根的名字）`)
  }
  const icon = rootIconName(entryNames)
  if (icon.error) out.push(`${p}${icon.error}`)
  const backend = manifest.backend
  if (typeof backend === 'string' && backend !== '' && !entryNames.includes(backend)) {
    out.push(`${p}包里没有后端入口文件 ${backend}（清单 backend 指的就是它在包里的路径）`)
  }
  return out
}

/** PK-006：入口 html 里要扫的引用 */
const REFERENCE_PATTERN = /(?:src|href)\s*=\s*["']([^"']+)["']/g

/** 放行但不需要落在包内的引用前缀 */
const INLINE_PROTOCOLS = /^(data:|blob:)/i

/**
 * 入口文档的引用必须落在包内，一条都不许指到包外（PK-006）。
 *
 * 包要能在别人机器上离线跑起来：外部 URL、根绝对路径、越出包根的相对路径都点名；
 * `data:` / `blob:` 与锚点放行。
 */
export function referenceProblems(html: string): string[] {
  const out: string[] = []
  for (const matched of html.matchAll(REFERENCE_PATTERN)) {
    const ref = matched[1]
    if (ref === undefined) continue
    const value = ref.trim()
    if (value === '' || value.startsWith('#')) continue
    if (INLINE_PROTOCOLS.test(value)) continue
    if (/^\/\//.test(value)) {
      out.push(`入口里有一条协议相对的外部引用 ${value}：包必须自带全部东西，装到机器上不能依赖网络`)
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      out.push(`入口里有一条外部引用 ${value}：包必须自带全部东西，装到机器上不能依赖网络`)
      continue
    }
    if (value.startsWith('/')) {
      out.push(`入口里有一条绝对路径引用 ${value}：它相对的是盘符而不是包，换成包内的相对路径`)
      continue
    }
    let depth = 0
    for (const segment of value.split('/')) {
      if (segment === '..') depth -= 1
      else if (segment !== '' && segment !== '.') depth += 1
      if (depth < 0) break
    }
    if (depth < 0) {
      out.push(`入口里有一条越出包根的引用 ${value}：包里的东西只能在包内互相引用`)
    }
  }
  return out
}
