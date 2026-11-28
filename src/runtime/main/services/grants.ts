import type { AppId } from '@airship/contract'
import { readDenied, writeDenied } from '@airship/contract'
import { appCacheDir, appDataDir, isInside } from './paths'
import { log } from './logging'

/**
 * 路径授权表。
 *
 * 规则很简单，也很好解释：
 *   1. 应用自己的 data/ 和 cache/ 目录内，随便读写。
 *   2. 其余路径，必须是用户本次会话里通过系统对话框显式选中的，才给读；
 *      选中目录则其后代一并可读。
 *   3. 写只额外开放给"另存为"对话框选中的那一个路径。
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

function inOwnSpace(app: AppId, target: string): boolean {
  return isInside(appDataDir(app), target) || isInside(appCacheDir(app), target)
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

  /** 授权过的路径数量（诊断与用例用） */
  stats(app: AppId): { read: number; write: number } {
    return {
      read: bag(readGrants, app).size,
      write: bag(writeGrants, app).size
    }
  },

  /**
   * 忘掉这个应用攒下的全部路径授权。
   *
   * 授权记的是 id，而 id 认不出"这还是不是同一只手写的包"——换一份同名包回来时，
   * 不该接着读到上一份攒下的那些路径。表在进程内，本来重启就空；
   * 这一条让"清掉授权"当场生效，不用等人重启一次。
   */
  forget(app: AppId): void {
    readGrants.delete(app)
    writeGrants.delete(app)
  }
}
