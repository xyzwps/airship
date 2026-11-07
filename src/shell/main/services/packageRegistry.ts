import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { manifestProblems } from '@airship/contract'
import {
  ICON_PATTERN,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  entryOf,
  packageManifestProblems,
  type PackageManifest
} from '@airship/contract'
import type { AppMeta } from '@airship/contract'
import type { Capability, PlatformId, SharedNamespace, ToolName } from '@airship/contract'
import { platformIssue } from '@airship/contract'
import { comparePackageNames, type PackageOrigin, type PackageRoot } from './packageRoots'
import { archiveEntryNames, readArchiveText } from './packageArchive'

/**
 * 运行期包注册表——壳在磁盘上找应用，不在构建期认应用。
 *
 * 取代的是原来那份构建期 glob（`import.meta.glob` 抓 `apps/<id>/app.ts`）。
 * 对外的函数名与旧 registry 一一对得上，所以 `ipc.ts`、`grants`、`paths.ts`、`windows.ts`
 * 一行都没改——**能力边界不在这次改动里**，它照旧由"谁调用（event.sender）+ 清单声明了什么"决定。
 *
 * 一个包就是**一个归档文件** `<id>.airship`（zip 换了扩展名），里面是应用的产物 + `manifest.json`。
 * 读它走 `packageArchive.ts`：只解要用的那一个条目，不整包展开。
 *
 * 三条规矩（契约见 `src/apps/specs/package.md`）：
 *   1. 一级文件名必须以 `.airship` 结尾才算包；`.tmp-` / `.prev-` 那种暂存名不是（PK-010）。
 *   2. **坏包不占名**：清单不合格的那一份连 id 都拿不到，压不住同 id 能用的包（PK-009）。
 *   3. 先到先得：根的顺序就是优先级（开发根 → 自装根），被遮住的写进问题清单（PK-008）。
 */

export interface InstalledPackage {
  /** 壳侧只看应用自己的事实那一份 */
  meta: AppMeta
  /** 包清单原样（含 schemaVersion / sdkVersion / entry） */
  manifest: PackageManifest
  /** 归档文件的绝对路径：`…/<id>.airship` */
  archive: string
  /** 这个包来自哪个根 */
  origin: PackageOrigin
  /** 入口文档地址：`airship://<id>/<entry>` */
  entryUrl: string
  /** 图标地址：`airship://<id>/<icon 的条目名>`；归档根上不止一张或一张都没有就是 null */
  iconUrl: string | null
}

export interface PackageProblem {
  /** 出问题的归档路径（被遮住的那种写的是被遮住的那一份） */
  at: string
  /** 人读的原因 */
  reason: string
}

export interface ScanResult {
  packages: InstalledPackage[]
  problems: PackageProblem[]
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
 * 读一个归档并判合格性——**扫描与装包共用这一份判据**。
 *
 * 装包那条路如果另写一套校验，就会出现"拖进去说能装、重启后扫不出来"这种分裂。
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

/** 扫一批根。同一 id 只留先扫到的那一份，后面的写进问题清单 */
export function scanPackages(roots: readonly PackageRoot[]): ScanResult {
  const packages: InstalledPackage[] = []
  const problems: PackageProblem[] = []
  const byId = new Map<string, InstalledPackage>()

  for (const root of roots) {
    let names: string[]
    try {
      // 包根不存在是常态（自装根要装进第一个包才有目录），不为它刷一句 warn：
      // "一个应用都没装进来"那种真情况由 appRegistry 在扫完之后统一喊。
      if (!existsSync(root.dir)) continue
      names = readdirSync(root.dir).filter((n) => n.endsWith(PACKAGE_SUFFIX) && statSync(join(root.dir, n)).isFile())
    } catch (e) {
      problems.push({ at: root.dir, reason: `包根读不出来：${e instanceof Error ? e.message : String(e)}` })
      continue
    }

    for (const name of names.sort(comparePackageNames)) {
      const archive = join(root.dir, name)
      const checked = validateArchive(archive)
      const manifest = checked.manifest
      if (!manifest || checked.problems.length > 0) {
        for (const reason of checked.problems) problems.push({ at: archive, reason })
        continue
      }

      const holder = byId.get(manifest.id)
      if (holder) {
        problems.push({
          at: archive,
          reason: `同一个 id 已经有包了：${manifest.id} 来自${labelOf(holder.origin)}的 ${holder.archive}，这一份不装`
        })
        continue
      }

      const installed: InstalledPackage = {
        meta: manifest,
        manifest,
        archive,
        origin: root.origin,
        entryUrl: `airship://${manifest.id}/${entryOf(manifest)}`,
        // 图标名由 validateArchive 一次读出，别再为同一个归档多解一遍中央目录
        iconUrl: checked.iconName ? `airship://${manifest.id}/${checked.iconName}` : null
      }
      byId.set(manifest.id, installed)
      packages.push(installed)
    }
  }

  return { packages, problems }
}

function labelOf(origin: PackageOrigin): string {
  return origin === 'dev' ? '开发/测试根' : '自装根'
}

export { labelOf as packageOriginLabel }

/* ---------------- 活的那一份：主进程启动时扫一次 ---------------- */

let scanned: ScanResult = { packages: [], problems: [] }
const byId = new Map<string, InstalledPackage>()

/** 主进程启动时调一次；返回的问题清单要落进日志与诊断页 */
export function loadPackages(roots: readonly PackageRoot[]): ScanResult {
  scanned = scanPackages(roots)
  byId.clear()
  for (const pkg of scanned.packages) byId.set(pkg.meta.id, pkg)
  return scanned
}

export function packageProblems(): PackageProblem[] {
  return scanned.problems
}

export function installedPackages(): InstalledPackage[] {
  return [...byId.values()]
}

/** 按 id 取包（归档路径、入口地址、图标地址都在返回的那份里） */
export function packageFor(id: string): InstalledPackage | null {
  return byId.get(id) ?? null
}

/* ---------------- 与旧 appRegistry 对齐的读法 ---------------- */

export function appIds(): string[] {
  return [...byId.keys()]
}

/** 按名字典序排好的元数据；顺序是壳的表现决定，不由应用自己声明 */
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
  return packagesAvailableOn(platform).map((p) => p.meta)
}

/** 同上，但要包地址的那一份：启动器摆格子用的是它（图标地址在包里） */
export function packagesAvailableOn(platform: PlatformId | 'unknown'): InstalledPackage[] {
  return installedPackages()
    .filter((p) => availableOn(p.meta.id, platform))
    .sort((a, b) => a.meta.name.localeCompare(b.meta.name, 'zh'))
}
