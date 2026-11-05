import type { AppId } from '../../shared/protocol'
import { APP_MAP } from '../../shared/registry'
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
  const meta = APP_MAP[app]
  if (!meta?.sharedNamespaces?.length) return []
  return Object.values(sharedDirsFor(meta.sharedNamespaces)).filter((v): v is string => Boolean(v))
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
      throw new Error(`没有读取权限：${path}（只能读应用数据目录，或先用文件对话框选中它）`)
    }
  },

  assertWrite(app: AppId, path: string): void {
    if (!this.canWrite(app, path)) {
      log.warn(app, '拒绝写入未授权路径', { path })
      throw new Error(`没有写入权限：${path}（只能写应用数据目录，或用另存为对话框选定目标）`)
    }
  },

  /** 授权过的路径数量，给壳的诊断界面用 */
  stats(app: AppId): { read: number; write: number } {
    return {
      read: bag(readGrants, app).size,
      write: bag(writeGrants, app).size
    }
  }
}
