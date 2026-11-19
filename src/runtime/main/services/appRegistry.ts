import { basename } from 'node:path'
import { packageRejected } from '@airship/contract'
import { log } from './logging'
import { packageFor, registerPackageAt, type InstalledPackage } from './packageRegistry'
import type { AppMeta } from '@airship/contract'

/**
 * 主进程侧的应用注册表门面。
 *
 * 表本身住在 packageRegistry.ts（这次进程跑着的包）；这里只加一件事：
 * **注册失败要响亮**——命令行指来的包不合格就把原因抛出去，由入口念给人听，
 * 不存在"静默少一个应用"这条路。
 *
 * 能力边界照旧由"谁调用（event.sender 反查）+ 那份清单声明了什么"决定，
 * 读法全部直接转给 packageRegistry：表是进程级的，没有"扫没扫过"这种时序问题。
 */

/** 注册一份命令行指来的归档；不合格或同 id 撞另一份归档时抛人读的原因 */
export function registerPackage(archive: string): InstalledPackage {
  const { pkg, problems } = registerPackageAt(archive)
  if (!pkg) throw new Error(packageRejected(basename(archive), problems))
  log.info('runtime', '命令行指来的包', { id: pkg.meta.id, archive })
  return pkg
}

/** id → 应用清单（窗口尺寸与标题按它定）；没注册就是 null */
export function metaOf(id: string): AppMeta | null {
  return packageFor(id)?.meta ?? null
}

export {
  appIds,
  appsAvailableOn,
  appsInOrder,
  availableOn,
  canAccessShared,
  canUseTool,
  capabilitiesOf,
  hasCapability,
  isKnownApp,
  packageFor,
  registeredPackages,
  resetRegistry,
  sharedNamespacesOf,
  toolsOf,
  unavailableReason
} from './packageRegistry'
export type { InstalledPackage } from './packageRegistry'