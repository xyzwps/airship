/**
 * 窗口台账（纯逻辑）。
 *
 * "哪个应用现在有活着的窗口"这个事实被抽出来，是因为它是三条用户可见契约的根：
 *   1. 再点一次同一个应用 → 聚焦已有窗口，而不是开出第二个；
 *   2. 窗口状态按应用各记一份 → 重启后各自回到上次的尺寸与位置；
 *   3. 关掉窗口 → 该应用名下的子进程要跟着收掉。
 * 这条规则埋在 BrowserWindow 调用里就没法验证，拎出来就能——和 services/routing.ts 同一个理由。
 */

/** owner：'shell' 是启动器，其余是应用 id */
const SHELL = 'shell'

export interface LedgerWindow {
  contentsId: number
}

export type OpenDecision = 'focus' | 'create'

export class WindowLedger {
  /** 归属 → 当前活着的那个窗口 */
  private byOwner = new Map<string, LedgerWindow>()
  /** webContents.id → 归属，主进程所有权限判定都从这里出发 */
  private owners = new Map<number, string>()

  /** 登记一个窗口的出生 */
  open(owner: string, contentsId: number): void {
    // 同一归属只留最新一个：窗口被销毁后重开，旧的 id 不该继续能认领
    const prev = this.byOwner.get(owner)
    if (prev) this.owners.delete(prev.contentsId)
    this.byOwner.set(owner, { contentsId })
    this.owners.set(contentsId, owner)
  }

  /** 窗口没了：按 webContents.id 摘掉，归属随之解除 */
  close(contentsId: number): string | null {
    const owner = this.owners.get(contentsId) ?? null
    if (owner === null) return null
    this.owners.delete(contentsId)
    if (this.byOwner.get(owner)?.contentsId === contentsId) this.byOwner.delete(owner)
    return owner
  }

  /** 这个归属现在还活着吗 */
  live(owner: string): boolean {
    return this.byOwner.has(owner)
  }

  /** 再点这个应用要干什么：聚焦已有的，还是新开一个 */
  decision(owner: string): OpenDecision {
    return this.live(owner) ? 'focus' : 'create'
  }

  /** 当前开着的应用（不含启动器），按登记顺序 */
  openAppIds(): string[] {
    return [...this.byOwner.keys()].filter((owner) => owner !== SHELL)
  }

  /** webContents → 归属；查不到就是野窗口 */
  ownerOf(contentsId: number): string | null {
    return this.owners.get(contentsId) ?? null
  }
}

/** 窗口状态在壳设置里的键：一应用一份，启动器自己一份 */
export function boundsKeyFor(owner: string): string {
  return owner === SHELL ? 'launcherWindow' : `appWindow:${owner}`
}

/** 任务栏身份：每应用一个 AppUserModelId，才能单独固定与预览 */
export function appUserModelIdFor(owner: string, prefix = 'dev.xyzwp.airship'): string {
  return owner === SHELL ? prefix : `${prefix}.${owner}`
}

/** 窗口落下的位置信息：尺寸、坐标、是否最大化 */
export interface WindowBounds {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
}

/**
 * 记进设置的窗口状态。
 * 最大化时不写坐标：那是"占满屏幕"的假位置，下次照着恢复会跑到屏幕外。
 */
export function boundsToSave(b: { width: number; height: number; x: number; y: number }, maximized: boolean): WindowBounds {
  return maximized
    ? { width: b.width, height: b.height, maximized: true }
    : { width: b.width, height: b.height, x: b.x, y: b.y, maximized: false }
}

/** 恢复时用哪个初始位置：上次记下的，或这一档窗口的默认尺寸 */
export function boundsForRestore(saved: WindowBounds | null | undefined, fallback: { width: number; height: number }): WindowBounds {
  if (!saved || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
    return { ...fallback, maximized: false }
  }
  return {
    width: saved.width,
    height: saved.height,
    x: saved.maximized ? undefined : saved.x,
    y: saved.maximized ? undefined : saved.y,
    maximized: saved.maximized === true
  }
}
