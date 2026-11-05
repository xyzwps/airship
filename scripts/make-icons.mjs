/**
 * 生成托盘图标和窗口图标，不依赖任何绘图库。
 *
 * 用法：node scripts/make-icons.mjs
 * 产物：assets/tray.png（16x16）、assets/icon.png（256x256）
 *
 * 图形是一条飞船舷窗式的圆角方块 + 中间一道斜向的"航迹"，
 * 纯代码画，改颜色只动下面几个常量。
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const assetsDir = join(here, '..', 'assets')

// 主色：深空蓝底 + 暖白航迹
const BG = [46, 58, 84]
const FG = [240, 236, 226]

/** 生成 RGBA 像素数组 */
function raster(size, draw) {
  const px = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const [r, g, b, a] = draw(x, y, size)
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = a
    }
  }
  return px
}

function drawShip(x, y, size) {
  const u = size / 16 // 以 16 格为设计单位的比例
  const cx = (x + 0.5) / u
  const cy = (y + 0.5) / u

  // 圆角方块，半径 4.5 格
  const r = 4.5
  const dx = Math.max(r - cx, cx - (16 - r), 0)
  const dy = Math.max(r - cy, cy - (16 - r), 0)
  const dist = Math.hypot(dx, dy)
  const edge = r - dist // >0 在内
  if (edge < -0.75) return [0, 0, 0, 0]

  // 航迹：一条从左下到右上的斜带，宽 2.2 格
  const band = Math.abs(cx + cy - 16) / Math.SQRT2
  const inBand = band < 1.1
  // 舷窗：中上方一个小圆
  const porthole = Math.hypot(cx - 8, cy - 5.6) < 1.5

  const alpha = Math.min(1, Math.max(0, edge + 0.75)) * 255
  const col = inBand || porthole ? FG : BG
  return [col[0], col[1], col[2], Math.round(alpha)]
}

/** 手工拼一个最小可用的 PNG */
function png(size, px) {
  const chunks = []

  const crcTable = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    chunks.push(len, body, crc)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  chunk('IHDR', ihdr)

  // 每行前面加一个 filter byte 0
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    Buffer.from(px.buffer, px.byteOffset + y * size * 4, size * 4).copy(raw, rowStart + 1)
  }
  chunk('IDAT', deflateSync(raw, { level: 9 }))
  chunk('IEND', Buffer.alloc(0))

  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

mkdirSync(assetsDir, { recursive: true })

const specs = [
  ['tray.png', 16],
  ['icon.png', 256]
]

for (const [name, size] of specs) {
  const px = raster(size, drawShip)
  const file = join(assetsDir, name)
  writeFileSync(file, png(size, px))
  console.log(`${name}  ${size}x${size}  ->  ${file}`)
}
