import type { AppMeta } from './app.ts'
import { APP_ID_PATTERN } from './app.ts'
import { badAppId } from './errors.ts'

/**
 * 一个 airship 包的清单形状（契约见 `src/apps/specs/package.md`）。
 *
 * 这份文件是**壳侧**判的规矩；`code/pack-app.mjs` 是产包侧判的规矩。
 * 两份必须逐条一致——由 `src/apps/tests/package.test.ts` 拿同一批坏清单喂两边，
 * 比对两边的原因列表完全相同来钉住（Node 跑不了本仓 TS，没法直接共用一份实现）。
 */

/** 包目录名的后缀：`<id>` + 这个 */
export const PACKAGE_SUFFIX = '.airship'

/** 包清单的文件名，在包根 */
export const MANIFEST_NAME = 'manifest.json'

/** 壳只认这一档包格式 */
export const SCHEMA_VERSION = 1

/** 入口文档的默认名字（清单不写 entry 就是它） */
export const DEFAULT_ENTRY = 'index.html'

/** 图标仍是文件约定，不进清单 */
export const ICON_PATTERN = /^icon\.(svg|png|jpe?g|webp)$/

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
 * 包清单的形状判定。返回**人读的原因列表**，空数组就是通过。
 *
 * 不判能力名与工具名——那两条住在 `manifestProblems()`（两侧共用的一份，
 * 主进程注册表与渲染侧都调它），这里只补包格式独有的三样。
 */
export function packageManifestProblems(manifest: unknown, at: string): string[] {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return [`${at}: 包清单必须是一个 JSON 对象`]
  }
  const m = manifest as Record<string, unknown>
  const out: string[] = []

  const id = m.id
  if (typeof id !== 'string' || id === '') {
    out.push(`${at}: 包清单缺 id，或 id 不是字符串`)
  } else if (!APP_ID_PATTERN.test(id)) {
    out.push(`${at}: ${badAppId(id)}`)
  }

  if (m.schemaVersion !== SCHEMA_VERSION) {
    out.push(
      `${at}: 包清单 schemaVersion 只认 ${SCHEMA_VERSION}，收到 ${JSON.stringify(m.schemaVersion)}` +
        `（包格式与壳不同档时别硬装，先对齐壳的版本）`
    )
  }
  if (typeof m.sdkVersion !== 'string' || m.sdkVersion.trim() === '') {
    out.push(`${at}: 包清单缺 sdkVersion：写构建这个包时用的 SDK 版本，例如 "1.0.0"`)
  }
  for (const key of ['name', 'description'] as const) {
    const v = m[key]
    if (typeof v !== 'string' || v.trim() === '') {
      out.push(`${at}: 包清单 ${key} 必须是非空字符串，收到 ${JSON.stringify(v)}`)
    }
  }
  if (!Array.isArray(m.capabilities) || m.capabilities.some((c) => typeof c !== 'string')) {
    out.push(`${at}: 包清单 capabilities 必须是字符串数组，用不到就写空数组`)
  }
  if (m.entry !== undefined && typeof m.entry !== 'string') {
    out.push(
      `${at}: 包清单 entry 不写就等于 ${DEFAULT_ENTRY}，写了必须是字符串，收到 ${JSON.stringify(m.entry)}`
    )
  }
  if (typeof m.entry === 'string' && m.entry !== '' && !isInsidePackagePath(m.entry)) {
    out.push(`${at}: 包清单 entry 必须是包内的相对路径，收到 ${JSON.stringify(m.entry)}`)
  }
  for (const key of REJECTED_KEYS) {
    if (key in m) {
      out.push(
        `${at}: 包清单里不写 ${key}：图标是包根那一张文件（icon.svg / png / jpg / jpeg / webp），` +
          `显示顺序由壳按名字典序定，两者都不是应用自己能决定的`
      )
    }
  }
  for (const key of Object.keys(m)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      out.push(`${at}: 包清单有壳不认的键 "${key}"（要么拼错，要么包格式与壳不同档）`)
    }
  }
  return out
}
