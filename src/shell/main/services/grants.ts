import type { AppId } from '@airship/contract'
import { readDenied, writeDenied } from '@airship/contract'
import { sharedNamespacesOf } from './appRegistry'
import { appCacheDir, appDataDir, isInside, sharedDirsFor } from './paths'
import { log } from './logging'

/**
 * 路径授权表。
 *
 * 规则很简单，也很好解释：
 *   1. 应用自己的 data/ 和 cache/ 目录内，随便读写。
 *   2. 应用 manifest 里声明过的共享命名空间目录内，也可读写（books 与 pdf 共用书库）。
 *   3. 其余路径，必须是用户本次会话里通过系统对话框显式选中的，才给读；
 *      选中目录则其后代一并可读。
 *   4. 写只额外开放给"另存为"对话框选中的那一个路径。
 *
 * 授权只在进程生命周期内有效，重启即清空——不持久化，避免越权残留。
 */

const readGrants = new Map<AppId, Set<string>>()
const writeGrants = new Map<AppId, Set<string>>()

function bag(map: Map<AppId, Set<string>>, app: AppId): Set<string> {
  let set = map.get(app)
  if (!set) {
    set = new Set()
    map.set(app, set)
  }
  return set
}

/** 应用声明过的共享目录，天然可读写 */
function sharedRoots(app: AppId): string[] {
  const namespaces = sharedNamespacesOf(app)
  if (namespaces.length === 0) return []
  return Object.values(sharedDirsFor(namespaces)).filter((v): v is string => Boolean(v))
}

function inOwnSpace(app: AppId, target: string): boolean {
  if (isInside(appDataDir(app), target) || isInside(appCacheDir(app), target)) return true
  return sharedRoots(app).some((root) => isInside(root, target))
}

function granted(set: Set<string>, target: string): boolean {
  for (const g of set) {
    if (isInside(g, target)) return true
  }
  return false
}

export const grants = {
  grantRead(app: AppId, path: string): void {
    bag(readGrants, app).add(path)
  },

  grantWrite(app: AppId, path: string): void {
    bag(writeGrants, app).add(path)
  },

  canRead(app: AppId, path: string): boolean {
    return inOwnSpace(app, path) || granted(bag(readGrants, app), path)
  },

  canWrite(app: AppId, path: string): boolean {
    return inOwnSpace(app, path) || granted(bag(writeGrants, app), path)
  },

  assertRead(app: AppId, path: string): void {
    if (!this.canRead(app, path)) {
      log.warn(app, '拒绝读取未授权路径', { path })
      throw new Error(readDenied(path))
    }
  },

  assertWrite(app: AppId, path: string): void {
    if (!this.canWrite(app, path)) {
      log.warn(app, '拒绝写入未授权路径', { path })
      throw new Error(writeDenied(path))
    }
  },

  /** 授权过的路径数量，给壳的诊断界面用 */
  stats(app: AppId): { read: number; write: number } {
    return {
      read: bag(readGrants, app).size,
      write: bag(writeGrants, app).size
    }
  },

  /**
   * 忘掉这个应用攒下的全部路径授权。
   *
   * 卸载时调：重装回来的那个同名应用不该接着读到上一次会话里拖进去的那些路径——
   * 授权记的是 id，而 id 认不出"这还是不是同一只手写的包"。
   * 表在进程内，本来重启就空；这一条让"卸掉"当场生效，不用等人重启一次。
   */
  forget(app: AppId): void {
    readGrants.delete(app)
    writeGrants.delete(app)
  }
}
