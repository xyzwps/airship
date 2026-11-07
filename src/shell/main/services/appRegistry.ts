import { app } from 'electron'
import { log } from './logging'
import { packageRoots } from './packageRoots'
import { loadPackages, packageProblems as scanProblems, type InstalledPackage } from './packageRegistry'
import type { AppMeta } from '@airship/contract'

/**
 * 主进程侧的应用注册表——**现在是运行期的**，读的是磁盘上的 airship 包。
 *
 * 原来它靠构建期 glob（`import.meta.glob` 抓 `apps/<id>/app.ts`）认应用，所以改一个应用要重出整个安装包；
 * 现在它在启动时扫两个包根（开发根与自装根，见 `packageRoots.ts`）——安装包是纯壳，不带应用。
 * 对外的函数名与旧版一一对得上，所以 `ipc.ts`、`grants`、`paths.ts`、`windows.ts` 一行没改——
 * **能力边界不在这次改动里**：照旧是"谁调用（event.sender 反查）+ 那份清单声明了什么"。
 *
 * 规矩只有一句：清单不合格就不进这张表，而不合格的原因必须喊出来
 * ——读出来包没装进来是"格子里凭空少一个应用"，没人看得懂。
 */

let byId = new Map<string, InstalledPackage>()
let loaded = false

/** 主进程启动时扫一次；`just dev` 要先 `just build-apps` 把包产到 dist-apps */
export function scanInstalledPackages(): InstalledPackage[] {
  const roots = packageRoots({
    isPackaged: app.isPackaged,
    env: process.env,
    userDataDir: app.getPath('userData')
  })
  const scan = loadPackages(roots)
  byId = new Map(scan.packages.map((p) => [p.meta.id, p]))
  loaded = true

  for (const pkg of scan.packages) {
    log.info('shell', '装进壳的包', {
      id: pkg.meta.id,
      origin: pkg.origin,
      archive: pkg.archive,
      sdkVersion: pkg.manifest.sdkVersion
    })
  }
  for (const problem of scan.problems) {
    log.warn('shell', '这个包没装进来', { at: problem.at, reason: problem.reason })
  }
  if (scan.packages.length === 0) {
    log.error('shell', '一个应用都没装进来', { 找过的包根: roots.map((r) => r.dir) })
  }
  return scan.packages
}

/** 没扫过就问不出任何应用：第一次用到就扫，用例也走这条路 */
function ensure(): void {
  if (!loaded) scanInstalledPackages()
}

/**
 * 自装根的路径——拖放装包唯一允许的落点。
 *
 * 也不选开发根：那是 just build-apps 的产物目录，人手往里拷东西只会下次就被覆盖。
 * 没有第三个选择——安装包是纯壳，安装目录里不带应用。
 */
export function installedRootDir(): string {
  const roots = packageRoots({
    isPackaged: app.isPackaged,
    env: process.env,
    userDataDir: app.getPath('userData')
  })
  const hit = roots.find((r) => r.origin === 'installed')
  if (!hit) throw new Error('这台机器上没有可用的自装根（LOCALAPPDATA 与 userData 都拿不到）')
  return hit.dir
}

/** 按 id 取整个包（入口地址、图标地址、包目录、包清单原样） */
export function packageFor(id: string): InstalledPackage | null {
  ensure()
  return byId.get(id) ?? null
}

/** 装进壳的包，按 id 序 */
export function installedPackages(): InstalledPackage[] {
  ensure()
  return [...byId.values()]
}

/** 每个没装进来的包与它的原因，诊断页与日志都从这里念 */
export function packageProblemLines(): string[] {
  ensure()
  return scanProblems().map((p) => `${p.at}：${p.reason}`)
}

/** id → 应用清单（窗口尺寸与标题按它定）；没装进来就是 null */
export function metaOf(id: string): AppMeta | null {
  ensure()
  return byId.get(id)?.meta ?? null
}

/*
 * 下面这批读法**都要先 ensure()**，一个都不许直接 re-export。
 *
 * 上一版这里写的是 `export { appIds, ... } from './packageRegistry'`，看着等价，其实是漏的：
 * `paths.ts` 第一个问的就是 `appIds()`，那一趟要是没人扫过包根，它拿到空表、
 * 于是每个应用的数据目录都不建，错要到几十行开外的 `grants` 里才炸出来。
 * 每个口子自己保证扫过，才不存在"谁先到谁拿到空表"。
 */

import {
  appIds as idsOf,
  appsAvailableOn as appsOnPlatform,
  appsInOrder as appsSorted,
  availableOn as appAvailableOn,
  canAccessShared as sharedAllowed,
  canUseTool as toolAllowed,
  capabilitiesOf as capsOf,
  hasCapability as capHeld,
  isKnownApp as appKnown,
  packagesAvailableOn as packagesOnPlatform,
  sharedNamespacesOf as namespacesOf,
  toolsOf as toolsDeclared,
  unavailableReason as platformBlockReason
} from './packageRegistry'
import type { Capability, PlatformId, SharedNamespace, ToolName } from '@airship/contract'

export function appIds(): string[] {
  ensure()
  return idsOf()
}

/** 按名字典序排好的清单；顺序是壳的表现决定，不由应用自己声明 */
export function appsInOrder(): AppMeta[] {
  ensure()
  return appsSorted()
}

export function isKnownApp(value: unknown): value is string {
  ensure()
  return appKnown(value)
}

export function capabilitiesOf(app: string): readonly Capability[] {
  ensure()
  return capsOf(app)
}

export function hasCapability(app: string, capability: Capability): boolean {
  ensure()
  return capHeld(app, capability)
}

/** 应用能不能碰某个共享命名空间：既要有 shared 能力，也要在名单里 */
export function canAccessShared(app: string, ns: string): ns is SharedNamespace {
  ensure()
  return sharedAllowed(app, ns)
}

export function sharedNamespacesOf(app: string): SharedNamespace[] {
  ensure()
  return namespacesOf(app)
}

export function toolsOf(app: string): ToolName[] {
  ensure()
  return toolsDeclared(app)
}

export function canUseTool(app: string, tool: ToolName): boolean {
  ensure()
  return toolAllowed(app, tool)
}

export function unavailableReason(app: string, platform: PlatformId | 'unknown'): string | null {
  ensure()
  return platformBlockReason(app, platform)
}

export function availableOn(app: string, platform: PlatformId | 'unknown'): boolean {
  ensure()
  return appAvailableOn(app, platform)
}

/** 当前平台用得了的清单（截图工装按这个顺序逐个开窗口） */
export function appsAvailableOn(platform: PlatformId | 'unknown'): AppMeta[] {
  ensure()
  return appsOnPlatform(platform)
}

/** 同上，但要包地址的那一份：启动器摆格子用的是它 */
export function packagesAvailableOn(platform: PlatformId | 'unknown'): InstalledPackage[] {
  ensure()
  return packagesOnPlatform(platform)
}
