/**
 * 托盘徽标图标。
 *
 * Windows 托盘吃的是位图，主进程没有画字的能力，所以在渲染侧用 canvas 画，
 * 转成 PNG dataURL 交给壳。dagogo 用它显示"今天勾掉几个"。
 */
export async function renderTrayIcon(
  text: string,
  options: { size?: number; done?: boolean } = {}
): Promise<string> {
  const size = options.size ?? 16
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('拿不到 2D 上下文，无法生成托盘图标')

  const u = size / 16

  // 底：圆角方块
  const r = 4.5 * u
  ctx.beginPath()
  ctx.roundRect(0, 0, size, size, r)
  ctx.fillStyle = options.done ? '#4d7a5e' : '#2e3a54'
  ctx.fill()

  // 字：完成数，最多两位
  const label = text.slice(0, 2)
  ctx.fillStyle = '#f0ece2'
  ctx.font = `600 ${Math.round(size * (label.length > 1 ? 0.52 : 0.66))}px "Segoe UI", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, size / 2, size / 2 + size * 0.04)

  return canvas.toDataURL('image/png')
}
