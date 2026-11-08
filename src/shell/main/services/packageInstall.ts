import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  PACKAGE_SUFFIX,
  notAPackage,
  notRegistered,
  overwriteNeedsConfirm,
  packageNotRemoved,
  packageRejected,
  packageUnreadable,
  windowBlocksUninstall,
  type AppMeta,
  type Capability,
  type PackageManifest,
  type PackageRootOrigin
} from '@airship/contract'
import { installedRootDir, packageFor, scanInstalledPackages } from './appRegistry'
import { appBaseDir } from './paths'
import { grants } from './grants'
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
 *
 * 卸载是这条链的反向，收在下面 `uninstallPackage` 那一段：删的是**注册表里生效的那一份归档**，
 * 两档根都能删（开发根里的那个也是磁盘上的一个文件，删它就是删它，`just build-apps` 会再产回来）。
 * 卸完同样只做一件事：失效归档缓存 + 重扫，界面上没有的东西主进程不替它张罗。
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

/* ---------------- 卸载：把生效的那一份归档删掉 ---------------- */

export interface UninstallInput {
  /** 连 `userData/apps/<id>/`（data、cache、settings.json）一起删 */
  purgeData: boolean
  /**
   * 这一格此刻开着窗口。由调用方（`ipc.ts` 问窗口台账）算好传进来——
   * 服务层不 import 窗口那一族，判据才在没起 Electron 的用例里也测得到。
   */
  windowIsOpen: boolean
}

export interface UninstallOutcome {
  id: string
  name: string
  /** 删掉的这一份来自哪一档根（界面念的是 PACKAGE_ROOT_LABEL 那两个人话名字） */
  origin: PackageRootOrigin
  /** 真删掉了那一族目录；选了删数据但本来就没有，这里是 false */
  dataRemoved: boolean
  /** 选了删数据，但 `apps/<id>` 这一族在磁盘上不存在 */
  dataWasAbsent: boolean
  /** 另一档根里同 id 的那一份顶上了：格子里**还有**它（PK-008 的反面） */
  tookOverByOtherRoot: boolean
}

/** Windows 上正被协议请求读着的归档会一时删不掉，带三轮重试；试满照原样抛 */
function removeWithRetry(target: string, attempts = 3): void {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target)
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return
      if (i === attempts - 1 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (i + 1))
    }
  }
}

/**
 * 卸载。三条判据，都对着"少一条就会骗人"：
 *
 *   1. **窗口开着就不动磁盘**。归档正被 `airship://` 供着，删了那个窗口就活在一个
 *      后续请求全 404 的半死状态；也不许壳替人关窗口——正在编辑的东西不该由卸载这一下没了。
 *   2. **删的是注册表里那一份**，不是"某个根里同名那个"。两档根同 id 时（PK-008）
 *      生效的那一份没了，被遮住的那一份随之顶上——界面上必须念得出"格子里还有它"。
 *   3. **数据这一族由人当场选**。装包那张卡片承诺过"数据目录不会动"，卸载是唯一会动它的地方，
 *      所以这里要人说了算；选了留，重装还接着用；选了删，`apps/<id>` 整族没了。
 *
 * 归档路径、`apps/<id>` 那一路径都不出去：界面只交 id 与"删不删数据"。
 */
export function uninstallPackage(id: string, input: UninstallInput): UninstallOutcome {
  const pkg = packageFor(id)
  if (!pkg) throw new Error(notRegistered(id))
  if (input.windowIsOpen) throw new Error(windowBlocksUninstall(pkg.meta.name))

  try {
    removeWithRetry(pkg.archive)
  } catch (e) {
    throw new Error(packageNotRemoved(pkg.archive, (e as NodeJS.ErrnoException).message ?? String(e)))
  }
  forgetArchive(pkg.archive)

  let dataRemoved = false
  let dataWasAbsent = false
  if (input.purgeData) {
    const base = appBaseDir(id)
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true })
      dataRemoved = true
    } else {
      dataWasAbsent = true
    }
  }

  // 上一次会话里给它攒的路径授权跟着包一起作废
  grants.forget(id)

  // 卸完立刻重扫：格子里马上没有它（或换成另一档根那份），不用重启
  scanInstalledPackages()

  return {
    id,
    name: pkg.meta.name,
    origin: pkg.origin,
    dataRemoved,
    dataWasAbsent,
    tookOverByOtherRoot: packageFor(id) !== null
  }
}
