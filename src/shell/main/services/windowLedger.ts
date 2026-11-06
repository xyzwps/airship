/**
 * 窗口台账（纯逻辑）。
 *
 * "哪个应用现在有活着的窗口"这个事实被抽出来，是因为它是三条用户可见契约的根：
 *   1. 再点一次同一个应用 → 聚焦已有窗口，而不是开出第二个；
 *   2. 关掉窗口 → 该应用名下的子进程要跟着收掉；
 *   3. 主进程所有权限判定都从"这个 webContents 归属谁"出发。
 * 这条规则埋在 BrowserWindow 调用里就没法验证，拎出来就能——和 services/routing.ts 同一个理由。
 *
 * 这里**不再有**窗口状态的读写：位置与尺寸都不记（判据见 `src/shell/specs/shell.md` SH-015/016/018）。
 * 记过一次就改不动、换块屏幕还会把窗口丢到屏外，而换来的只是"下次开在同一个地方"；
 * 版心宽度本来由清单定，位置交给系统摆已经够用。
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

/** 任务栏身份：每应用一个 AppUserModelId，才能单独固定与预览 */
export function appUserModelIdFor(owner: string, prefix = 'dev.xyzwp.airship'): string {
  return owner === SHELL ? prefix : `${prefix}.${owner}`
}

/**
 * 开这个应用的窗口用多大：清单写了就用它写的，没写的那一维跟壳的默认。
 * 两个字段各自独立，所以"只调宽度、高度随壳"这种写法是成立的。
 */
export function defaultSizeFor(
  meta: { defaultWidth?: number; defaultHeight?: number },
  base: { width: number; height: number }
): { width: number; height: number } {
  return {
    width: meta.defaultWidth ?? base.width,
    height: meta.defaultHeight ?? base.height
  }
}
