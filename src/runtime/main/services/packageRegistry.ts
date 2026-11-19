import { basename, join } from 'node:path'
import { manifestProblems } from '@airship/contract'
import {
  ICON_PATTERN,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  entryOf,
  packageManifestProblems,
  sameIdDifferentArchive,
  type PackageManifest
} from '@airship/contract'
import type { AppMeta } from '@airship/contract'
import type { Capability, PlatformId, SharedNamespace, ToolName } from '@airship/contract'
import { platformIssue } from '@airship/contract'
import { archiveEntryNames, readArchiveText } from './packageArchive'

/**
 * 运行期包注册表——**这张表只装"这次进程跑着的包"**。
 *
 * runtime 不扫磁盘认应用：包由命令行指过来（`airship.exe <id>.airship`，
 * 快捷方式与第二实例转发走的也是这条路），注册一份、开一个窗口。
 * 进程退出表就没了；下一次跑哪些包，由下一次 argv 决定。
 *
 * 一个包就是**一个归档文件** `<id>.airship`（zip 换了扩展名），里面是应用的产物 + `manifest.json`。
 * 读它走 `packageArchive.ts`：只解要用的那一个条目，不整包展开。
 *
 * 两条规矩（契约见 `src/apps/specs/package.md` 与 `src/runtime/specs/runtime.md`）：
 *   1. 清单不合格就不进这张表，原因逐条念出来（validateArchive 与产包期同一份判据）。
 *   2. 同一个 id 只认一份归档：同路径再指一次是聚焦，不同路径指过来拒并念清两份各在哪——
 *      不顶替，因为旧窗口的文档还由旧归档供着，顶替等于把它半路抽走。
 */

export interface InstalledPackage {
  /** runtime 侧只看应用自己的事实那一份 */
  meta: AppMeta
  /** 包清单原样（含 schemaVersion / sdkVersion / entry） */
  manifest: PackageManifest
  /** 归档文件的绝对路径：`…/<id>.airship` */
  archive: string
  /** 入口文档地址：`airship://<id>/<entry>` */
  entryUrl: string
  /** 图标地址：`airship://<id>/<icon 的条目名>`；归档根上不止一张或一张都没有就是 null */
  iconUrl: string | null
}

/** 归档根上那张唯一的图标；不是一张就说清为什么不是一张 */
function iconIn(archive: string): { name?: string; error?: string } {
  let names: string[]
  try {
    names = archiveEntryNames(archive)
  } catch (e) {
    return { error: `归档读不出来：${e instanceof Error ? e.message : String(e)}` }
  }
  // 只看包根那一层：条目名里没有斜杠的才算（assets/icon.svg 那种是应用自己的素材）
  const icons = names.filter((n) => !n.includes('/') && ICON_PATTERN.test(n))
  if (names.length === 0) return { error: '包里没有条目，也没有 manifest.json' }
  if (icons.length === 0) return { error: '包里缺图标 icon.svg（也接受 png / jpg / jpeg / webp）' }
  if (icons.length > 1) return { error: `包里的图标有多张，只留一张：${icons.join(', ')}` }
  return { name: icons[0]! }
}

/** 一个归档的合格性判定：清单形状 + 图标 + 入口在不在包里 */
function packageProblemsAt(
  archive: string,
  dirId: string,
  manifest: PackageManifest,
  icon: { name?: string; error?: string }
): string[] {
  const at = join(archive, MANIFEST_NAME)
  const out = [
    ...packageManifestProblems(manifest, at),
    // 与产包期同一份清单规矩：工具表、平台名、尺寸、id 与包名一致
    ...manifestProblems(at, dirId, manifest, [])
  ]
  // 两份规矩会各念一遍同一句（id 形状那类），诊断里留一句就够
  const entries = [...new Set(out)]

  if (icon.error) entries.push(`${archive}: ${icon.error}`)
  try {
    if (!archiveEntryNames(archive).includes(entryOf(manifest))) {
      entries.push(`${archive}: 包里没有入口文件 ${entryOf(manifest)}`)
    }
  } catch (e) {
    entries.push(`${archive}: 归档读不出来：${e instanceof Error ? e.message : String(e)}`)
  }
  return entries
}

/**
 * 读一个归档并判合格性——**直跑与安装器共用这一份判据**。
 *
 * 任何一条入口如果另写一套校验，就会出现"装的时候说能跑、直跑说不合格"这种分裂。
 * `problems` 为空才算合格；不合格时 `manifest` 可能压根没读出来，调用方只该看 problems。
 */
export function validateArchive(archive: string): {
  manifest?: PackageManifest
  iconName?: string
  problems: string[]
} {
  const fileName = basename(archive)
  const dirId = fileName.endsWith(PACKAGE_SUFFIX) ? fileName.slice(0, -PACKAGE_SUFFIX.length) : fileName

  let text: string | null
  try {
    text = readArchiveText(archive, MANIFEST_NAME)
  } catch (e) {
    return { problems: [`${archive}: 归档读不出来：${e instanceof Error ? e.message : String(e)}`] }
  }
  if (text === null) return { problems: [`${archive}: 缺 ${MANIFEST_NAME}`] }

  let manifest: PackageManifest
  try {
    manifest = JSON.parse(text) as PackageManifest
  } catch (e) {
    return {
      problems: [`${join(archive, MANIFEST_NAME)} 解析失败：${e instanceof Error ? e.message : String(e)}`]
    }
  }

  const icon = iconIn(archive)
  const problems = packageProblemsAt(archive, dirId, manifest, icon)
  return problems.length > 0 ? { problems } : { manifest, iconName: icon.name, problems: [] }
}

/* ---------------- 活的那一份：命令行指来的包 ---------------- */

const byId = new Map<string, InstalledPackage>()

/**
 * 注册一份命令行指来的归档。校验走 validateArchive，不存在"指来的包判得松一点"。
 *
 * 同 id 同归档：返回已在表里的那一份（调用方据此聚焦窗口）；
 * 同 id 不同归档：拒，problems 里是 sameIdDifferentArchive 那句原话。
 */
export function registerPackageAt(archive: string): { pkg?: InstalledPackage; problems: string[] } {
  const checked = validateArchive(archive)
  const manifest = checked.manifest
  if (!manifest || checked.problems.length > 0) return { problems: checked.problems }

  const holder = byId.get(manifest.id)
  if (holder) {
    if (holder.archive === archive) return { pkg: holder, problems: [] }
    return { problems: [sameIdDifferentArchive(manifest.id, holder.archive, archive)] }
  }

  const pkg: InstalledPackage = {
    meta: manifest,
    manifest,
    archive,
    entryUrl: `airship://${manifest.id}/${entryOf(manifest)}`,
    // 图标名由 validateArchive 一次读出，别再为同一个归档多解一遍中央目录
    iconUrl: checked.iconName ? `airship://${manifest.id}/${checked.iconName}` : null
  }
  byId.set(manifest.id, pkg)
  return { pkg, problems: [] }
}

/** 这次进程跑着的包，按注册顺序 */
export function registeredPackages(): InstalledPackage[] {
  return [...byId.values()]
}

/** 按 id 取包（归档路径、入口地址、图标地址都在返回的那份里） */
export function packageFor(id: string): InstalledPackage | null {
  return byId.get(id) ?? null
}

/* ---------------- 读法：能力边界只问这张表 ---------------- */

export function appIds(): string[] {
  return [...byId.keys()]
}

/** 按名字典序排好的元数据；顺序是 runtime 的表现决定，不由应用自己声明 */
export function appsInOrder(): AppMeta[] {
  return [...byId.values()].map((p) => p.meta).sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

export function isKnownApp(value: unknown): value is string {
  return typeof value === 'string' && byId.has(value)
}

export function capabilitiesOf(app: string): readonly Capability[] {
  return byId.get(app)?.meta.capabilities ?? []
}

export function hasCapability(app: string, capability: Capability): boolean {
  return capabilitiesOf(app).includes(capability)
}

/** 应用能不能碰某个共享命名空间：既要有 shared 能力，也要在名单里 */
export function canAccessShared(app: string, ns: string): ns is SharedNamespace {
  if (!hasCapability(app, 'shared')) return false
  const meta = byId.get(app)?.meta
  return (meta?.sharedNamespaces ?? []).includes(ns as SharedNamespace)
}

export function sharedNamespacesOf(app: string): SharedNamespace[] {
  return byId.get(app)?.meta.sharedNamespaces ?? []
}

export function toolsOf(app: string): ToolName[] {
  return byId.get(app)?.meta.tools ?? []
}

export function canUseTool(app: string, tool: ToolName): boolean {
  return hasCapability(app, 'proc') && toolsOf(app).includes(tool)
}

export function unavailableReason(app: string, platform: PlatformId | 'unknown'): string | null {
  const meta = byId.get(app)?.meta
  return meta ? platformIssue(meta, platform) : null
}

export function availableOn(app: string, platform: PlatformId | 'unknown'): boolean {
  return unavailableReason(app, platform) === null
}

/** 当前平台用得了的应用，按名字典序（截图工装按这个顺序逐个开窗口） */
export function appsAvailableOn(platform: PlatformId | 'unknown'): AppMeta[] {
  return registeredPackages()
    .filter((p) => availableOn(p.meta.id, platform))
    .map((p) => p.meta)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 工装：进程级状态清干净，让下一条用例从空表开始 */
export function resetRegistry(): void {
  byId.clear()
}