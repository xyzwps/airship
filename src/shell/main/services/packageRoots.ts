import { join, resolve } from 'node:path'
import type { PackageRootOrigin } from '@airship/contract'

/**
 * 包根——壳去哪儿找 airship 包。
 *
 * **两个根，顺序就是优先级**（先扫到的那份占住这个 id）：
 *
 *   1. dev       开发/测试根，由 `AIRSHIP_APPS_ROOT` 指过来（`just build-apps` 的落点 `dist-apps/`）。
 *                **发布版忽略这个变量**：否则一个 env 就成了产线上的路径注入面（PK-012）。
 *   2. installed 自装根 `%LOCALAPPDATA%/airship/apps`——拖进启动器装的那些，也是将来商店的落点。
 *                选 Local 不选 Roaming：企业环境会漫游 AppData，几百 MB 的包跟着漫游是灾难，
 *                而且 `%APPDATA%/airship` 在这台机器上是"用户数据"的语义，备份它的人
 *                不该顺带把可执行代码备份走。没装 LOCALAPPDATA 的平台上退回 userData 旁边。
 *
 * 没有第三个"出厂根"了：安装包是**纯壳**，不带任何应用（2026-11-07 定）。
 * 分发单位只有 airship 包，装应用只有拖放这一条入口。
 *
 * 同 id 时先扫到的占住，但**坏包不压**：校验不过的那一份根本不进注册表，
 * 也就占不住这个 id（见 packageRegistry.ts）。
 *
 * 这个文件不 import electron：把判定条件当参数收进来，运行期发现这件事才测得了。
 */

/** 一档根是哪一档：契约里那份说法，不在这里另立一套 */
export type PackageOrigin = PackageRootOrigin

export interface PackageRoot {
  dir: string
  origin: PackageOrigin
}

export interface PackageRootInput {
  /** 装进安装包的那一档；true 时忽略 AIRSHIP_APPS_ROOT */
  isPackaged: boolean
  /** process.env 的快照，便于用例注入 */
  env: NodeJS.ProcessEnv
  /** 用户数据目录（app.getPath('userData')）——非 Windows 上自装根退落到它旁边 */
  userDataDir: string
}

/** 自装根的名字：`airship/apps`（Windows 在 %LOCALAPPDATA% 下） */
const INSTALLED_SEGMENTS = ['airship', 'apps'] as const

export function packageRoots(input: PackageRootInput): PackageRoot[] {
  const out: PackageRoot[] = []

  const dev = input.env.AIRSHIP_APPS_ROOT
  if (!input.isPackaged && dev && dev.trim() !== '') {
    // justfile 传的是相对路径 dist-apps；按 cwd 解成绝对路径再扫，
    // 免得同一个变量在 from-仓库根 与 from-别处 两种跑法下指两个地方
    out.push({ dir: resolve(dev), origin: 'dev' })
  }

  const local = input.env.LOCALAPPDATA
  const installed =
    local && local.trim() !== ''
      ? join(local, ...INSTALLED_SEGMENTS)
      : join(input.userDataDir, ...INSTALLED_SEGMENTS)
  out.push({ dir: installed, origin: 'installed' })

  return out
}

/** 同一个根里谁的 id 先占住：按文件名字典序，扫法稳定可复现 */
export function comparePackageNames(a: string, b: string): number {
  return a.localeCompare(b, 'en')
}
