import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  PACKAGE_SUFFIX,
  notAPackage,
  overwriteNeedsConfirm,
  packageRejected,
  packageUnreadable,
  type AppMeta,
  type Capability,
  type PackageManifest
} from '@airship/contract'
import { installedRootDir, packageFor, scanInstalledPackages } from './appRegistry'
import { forgetArchive } from './packageArchive'
import { validateArchive } from './packageRegistry'

/**
 * 拖放装包：把一个 `<id>.airship` 归档装进自装根。
 *
 * 四条规矩，都是"少一条就会骗人"的那种：
 *
 *   1. **只认单个归档文件**。文件夹不支持——那条路要么得现场打包（与 `just build-apps`
 *      两套代码），要么得静默 zip 一下，两种都不是用户拖进来时以为发生的事。
 *   2. **装之前先过 `validateArchive`**，与运行期扫描同一份判据。不合格就一条字节都不落地，
 *      界面上念出为什么；不会出现"装上了但下次启动扫不出来"。
 *   3. **同 id 已在自装根里 → 必须确认才换**。覆盖是唯一真正不可逆的动作：
 *      下次打开这个应用跑的就是新代码，而 `%APPDATA%/airship/apps/<id>/` 那份数据会被新代码接着读。
 *      安装包是纯壳，安装目录里没有应用，所以"覆盖"只可能发生在自装根内部。
 *   4. **装 ≠ 运行**。装完只刷新格子，不开窗口。
 *
 * 落盘是"写暂存名 → 改名"，失败时把旧包挪回来：半途失败的装包不许把一个好好的包
 * 留在看不见的位置（这条与 `code/pack-app.mjs` 的 PK-007 同一个理由）。
 */

/** 装之前给人看的那份提案 */
export interface PackageProposal {
  /** 拖进来的归档 */
  archive: string
  /** 字节数，界面上说"这个包 279 KB" */
  bytes: number
  meta: PackageManifest
  /** 自装根里已有同 id 的那一份：非空就必须让人确认才动 */
  replacing: { meta: PackageManifest; archive: string } | null
  /** 相对已装的那一份多了哪些能力（确认卡片要念的就是这个） */
  addedCapabilities: Capability[]
  removedCapabilities: Capability[]
}

export interface InstallOutcome {
  id: string
  name: string
  /** 换掉了自装根里原有的版本 */
  replaced: boolean
}

/** Windows 上刚写下的文件常被短暂占用，改名带三轮重试；试满还不成就照原样抛 */
function renameWithRetry(from: string, to: string, attempts = 3): void {
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (i === attempts - 1 || (code !== 'EPERM' && code !== 'EACCES')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (i + 1))
    }
  }
}

/** 读一遍归档并给出提案；不合格直接抛人读的原因 */
export function inspectPackage(archive: string): PackageProposal {
  const name = basename(archive)

  let st
  try {
    st = statSync(archive)
  } catch (e) {
    throw new Error(packageUnreadable(archive, (e as NodeJS.ErrnoException).message ?? String(e)))
  }
  // 拖进来的可能是个文件夹（从资源管理器拖目录过来时 Chromium 也给得出一个"文件"条目）
  if (!st.isFile() || !name.endsWith(PACKAGE_SUFFIX)) throw new Error(notAPackage(name))

  const checked = validateArchive(archive)
  if (!checked.manifest || checked.problems.length > 0) throw new Error(packageRejected(name, checked.problems))
  const meta = checked.manifest

  const root = installedRootDir()
  const target = join(root, `${meta.id}${PACKAGE_SUFFIX}`)
  const existing = existsSync(target) ? packageFor(meta.id) : null
  // 用整份包清单（含 sdkVersion），确认卡片要念的就是版本号
    const replacing = existing && existing.origin === 'installed' ? { meta: existing.manifest, archive: existing.archive } : null

  const before = new Set(replacing?.meta.capabilities ?? [])
  const after = new Set(meta.capabilities)
  const addedCapabilities = meta.capabilities.filter((c) => !before.has(c))
  const removedCapabilities = [...before].filter((c) => !after.has(c))

  return {
    archive,
    bytes: st.size,
    meta,
    replacing,
    addedCapabilities,
    removedCapabilities
  }
}

/**
 * 落地。`overwrite: false` 且自装根里已有同 id → 抛"要确认"那句，界面上据此弹确认卡片。
 */
export function installPackage(archive: string, overwrite: boolean): InstallOutcome {
  const proposal = inspectPackage(archive)
  const { meta } = proposal

  if (proposal.replacing && !overwrite) {
    throw new Error(overwriteNeedsConfirm(meta.name, proposal.replacing.meta.sdkVersion, meta.sdkVersion))
  }

  const root = installedRootDir()
  mkdirSync(root, { recursive: true })
  const final = join(root, `${meta.id}${PACKAGE_SUFFIX}`)
  const staging = join(root, `${meta.id}${PACKAGE_SUFFIX}.tmp-${process.pid}-${Date.now()}`)
  const backup = join(root, `${meta.id}${PACKAGE_SUFFIX}.prev-${Date.now()}`)
  let movedOld = false

  try {
    copyFileSync(archive, staging)
    if (existsSync(final)) {
      renameWithRetry(final, backup)
      movedOld = true
    }
    renameWithRetry(staging, final)
    if (movedOld) {
      forgetArchive(backup)
      rmSync(backup, { force: true })
    }
  } catch (e) {
    rmSync(staging, { force: true })
    if (movedOld && !existsSync(final) && existsSync(backup)) renameWithRetry(backup, final)
    throw e
  }

  // 装完立刻重扫：格子里马上有它，不用重启
  forgetArchive(final)
  scanInstalledPackages()

  return { id: meta.id, name: meta.name, replaced: proposal.replacing !== null }
}
