import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { log } from './logging'
import { sendTo } from '../windows'
import type { TrayState } from '@shared/protocol'

/**
 * 托盘。
 *
 * 全局只有一个托盘图标，但多个应用都可能想用它（打勾勾显示今日完成数）。
 * 所以这里记"当前是谁占着"：
 *   - 应用只能清掉自己占的托盘，不能把别人的顶掉；
 *   - 点击托盘产生的 tray:click 只投给占用的那个应用的窗口。
 *
 * 带数字的图标由渲染侧画成 PNG dataURL 传进来——主进程没有画字的能力，
 * 硬编一个位图字体不值得。
 */

interface Holder {
  owner: string
  state: TrayState
}

let tray: Tray | null = null
let holder: Holder | null = null
let bringToFront: (() => void) | null = null

function defaultIcon(): NativeImage {
  const candidates = [
    join(__dirname, '../../assets/tray.png'),
    join(__dirname, '../../../assets/tray.png'),
    join(process.resourcesPath ?? '', 'tray.png')
  ]
  for (const c of candidates) {
    try {
      const img = nativeImage.createFromPath(c)
      if (!img.isEmpty()) return img
    } catch {
      /* 换下一个 */
    }
  }
  return nativeImage.createEmpty()
}

function rebuild(): void {
  if (!holder) return
  if (!tray) {
    tray = new Tray(defaultIcon())
    tray.on('click', () => {
      if (holder?.state.focusOnClick !== false) bringToFront?.()
      // 事件只给占着托盘的那个应用
      if (holder) sendTo(holder.owner, { kind: 'tray:click' })
    })
  }

  if (holder.state.iconDataUrl) {
    const img = nativeImage.createFromDataURL(holder.state.iconDataUrl)
    if (!img.isEmpty()) tray.setImage(img)
  }

  tray.setToolTip(holder.state.tooltip.slice(0, 120))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: holder.state.tooltip.slice(0, 60), enabled: false },
      { type: 'separator' },
      { label: '打开飞船', click: () => bringToFront?.() },
      { label: '退出', click: () => { tray?.destroy(); tray = null; holder = null; process.exit(0) } }
    ])
  )
}

export const trayService = {
  set(owner: string, state: TrayState, onFocus: () => void): void {
    bringToFront = onFocus
    holder = { owner, state }
    try {
      rebuild()
    } catch (err) {
      log.error('shell', '设置托盘失败', { error: String(err) })
    }
  },

  /** 只有占着托盘的应用能清它，别人调了是空操作 */
  clear(owner: string): void {
    if (!holder || holder.owner !== owner) return
    holder = null
    if (tray) {
      tray.destroy()
      tray = null
    }
  },

  /** 退出时不分归属，一律清掉 */
  clearForShutdown(): void {
    holder = null
    if (tray) {
      tray.destroy()
      tray = null
    }
  },

  get owner(): string | null {
    return holder?.owner ?? null
  },

  get active(): boolean {
    return tray !== null
  }
}
