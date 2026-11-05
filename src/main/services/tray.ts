import { Menu, Tray, nativeImage, type NativeImage } from 'electron'
import { join } from 'node:path'
import { log } from './logging'
import type { TrayState } from '../../shared/protocol'

/**
 * 托盘。
 *
 * dagogo 原来靠 Android 桌面小组件显示今日完成数，Windows 上没有对应物，
 * 最接近的就是托盘图标 + 提示文字。带数字的图标由渲染侧画成 PNG dataURL 传进来
 * （主进程没有画字的能力，硬编一个位图字体不值得）。
 */

let tray: Tray | null = null
let current: TrayState | null = null
let bringToFront: (() => void) | null = null

function defaultIcon(): NativeImage {
  const file = join(process.resourcesPath ?? '', 'tray.png')
  // 开发期图标在工程 assets 下，打包后在 resourcesPath 下
  const candidates = [
    join(__dirname, '../../assets/tray.png'),
    join(__dirname, '../../../assets/tray.png'),
    file
  ]
  for (const c of candidates) {
    try {
      const img = nativeImage.createFromPath(c)
      if (!img.isEmpty()) return img
    } catch {
      /* 换下一个 */
    }
  }
  // 兜底：16x16 全透明，至少不会因为没有图标而抛异常
  return nativeImage.createEmpty()
}

function rebuild(): void {
  if (!current) return
  if (!tray) {
    tray = new Tray(defaultIcon())
    tray.on('click', () => {
      if (current?.focusOnClick !== false) bringToFront?.()
    })
  }

  if (current.iconDataUrl) {
    const img = nativeImage.createFromDataURL(current.iconDataUrl)
    if (!img.isEmpty()) tray.setImage(img)
  }

  tray.setToolTip(current.tooltip.slice(0, 120))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: current.tooltip.slice(0, 60), enabled: false },
      { type: 'separator' },
      { label: '打开飞船', click: () => bringToFront?.() },
      { label: '退出', click: () => { tray?.destroy(); tray = null; process.exit(0) } }
    ])
  )
}

export const trayService = {
  set(state: TrayState, onFocus: () => void): void {
    bringToFront = onFocus
    current = state
    try {
      rebuild()
    } catch (err) {
      log.error('shell', '设置托盘失败', { error: String(err) })
    }
  },

  clear(): void {
    current = null
    if (tray) {
      tray.destroy()
      tray = null
    }
  },

  get active(): boolean {
    return tray !== null
  }
}
