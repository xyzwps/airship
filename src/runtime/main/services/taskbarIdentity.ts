import { app, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PACKAGE_SUFFIX, WINDOWS_ICON_NAME } from '@airship/contract'
import { log } from './logging'
import { readArchiveEntry } from './packageArchive'
import { taskbarIconFile } from './paths'
import { appUserModelIdFor } from './windowLedger'
import type { InstalledPackage } from './packageRegistry'

/**
 * 任务栏身份：一个应用在任务栏上是自己的那颗按钮，带着自己的图标与名字（契约见
 * `src/runtime/specs/runtime.md` SH-010 / SH-034 / SH-035）。
 *
 * 三件事缺一不可，而且都不在 Electron 的"窗口图标"那条路上：
 *
 *   1. **身份是逐窗口给的**——`win.setAppDetails()` 内部是 `ITaskbarList3::SetAppUserModelID`。
 *      `app.setAppUserModelId()` 是进程级的，八个应用共用一个 runtime 进程，那一句只能给出一个身份。
 *   2. **图标走磁盘**——外壳读 `appIconPath` 时只认文件系统路径，既不认 asar 也不认 `airship://`。
 *      所以包根那份派生的 `icon.ico`（PK-036）先由 runtime 摊平落到 `<userData>/icons/`，
 *      落盘按字节比对：包换了才重写，没换就不动磁盘。
 *   3. **命令行要同形**——固定到任务栏那颗按钮点下去跑的是 `relaunchCommand`，
 *      它与快捷方式一样是 `airship.exe "<归档绝对路径>"`。第二实例会把包路径转给活着的进程，
 *      所以唤起的正是那个应用，不会全都开成第一个指来的包。
 */

export interface TaskbarIdentity {
  /** `dev.xyzwp.airship.<id>`：每应用一个，才能单独固定与预览 */
  appId: string
  /** 磁盘上那份 ico；包里没有派生 ico 时是 null——身份照样分开，图标回落 runtime 的 */
  appIconPath: string | null
  relaunchCommand: string
  relaunchDisplayName: string
}

/** 包内那份 `icon.ico` 交到底盘上（内容没变就不重写），返回外壳能读的路径 */
export function taskbarIconFor(pkg: InstalledPackage): string | null {
  const raw = readArchiveEntry(pkg.archive, WINDOWS_ICON_NAME)
  if (!raw) {
    log.warn(pkg.meta.id, `包里缺 ${WINDOWS_ICON_NAME}，任务栏图标回落 runtime 的（产包期会派生这一份，见 PK-036）`)
    return null
  }
  const file = taskbarIconFile(pkg.meta.id)
  const want = Buffer.from(raw)
  if (existsSync(file) && Buffer.compare(readFileSync(file), want) === 0) return file
  writeFileSync(file, want)
  return file
}

/**
 * 未打包时 electron 得被指到 runtime 那个目录才起得来，所以 relaunch 命令行要带上同一段。
 * 打包后 `argv[1]` 就是归档本身，不再需要那一段（`just start` 与快捷方式各自成立）。
 */
export function runtimeDirFromArgv(argv: readonly string[]): string | null {
  const arg = argv.slice(1).find((a) => !a.startsWith('-') && !a.endsWith(PACKAGE_SUFFIX))
  return arg ? resolve(arg) : null
}

/** 与快捷方式同形的那条命令行：每一段都带引号（路径里有空格也不能散架） */
export function relaunchCommandFor(input: {
  execPath: string
  runtimeDir: string | null
  archive: string
}): string {
  return [input.execPath, ...(input.runtimeDir ? [input.runtimeDir] : []), input.archive]
    .map((part) => `"${part}"`)
    .join(' ')
}

/** 这个应用窗口的任务栏身份 */
export function taskbarIdentityFor(pkg: InstalledPackage): TaskbarIdentity {
  return {
    appId: appUserModelIdFor(pkg.meta.id),
    appIconPath: taskbarIconFor(pkg),
    relaunchCommand: relaunchCommandFor({
      execPath: process.execPath,
      runtimeDir: app.isPackaged ? null : runtimeDirFromArgv(process.argv),
      archive: pkg.archive
    }),
    relaunchDisplayName: pkg.meta.name
  }
}

/**
 * 把身份交给外壳。Windows 专有：macOS 与 Linux 上没有这套任务栏身份，
 * 这句就什么都不做（不做也不留下"看起来做了"的痕迹——所以不调可选链，直接判平台）。
 */
export function applyTaskbarIdentity(window: BrowserWindow, identity: TaskbarIdentity): void {
  if (process.platform !== 'win32') return
  const { appIconPath, ...details } = identity
  // relaunchCommand 与 relaunchDisplayName 必须成对给，少了另一条 Electron 会整对忽略；
  // appIconPath 缺了只是图标回落，不影响身份本身，所以不给这个键而不是给一个空串。
  window.setAppDetails(appIconPath ? { ...details, appIconPath } : details)
}
