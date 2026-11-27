/**
 * ICO 容器：只这一处懂字节布局。
 *
 * 形状按 `docs/apps/icons.md` 那份标准，而字段值取自仓内 12 张真 ico 的实测
 * （books / wsld / templates 三张逐帧读过：`reserved=0 type=1 colors=0 reserved=0 planes=0 bits=32`，
 * 帧按尺寸升序，首帧偏移 118 = 6 + 7×16）——不是照记忆写的。
 *
 * 帧内一律 PNG（Vista 之后的 ICO 形态）：渲染侧 `canvas.toBlob('image/png')` 出来的就是 RGBA 32 位，
 * 与标准那句"每帧 32 位色，帧内编码是 PNG 压缩"天然对上，不需要任何转码步骤。
 */

/** 标准那 7 帧；对作者的下限（16/32/48/256）是它的子集 */
export const ICON_FRAME_SIZES = [16, 24, 32, 48, 64, 128, 256]

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const HEADER_BYTES = 6
const ENTRY_BYTES = 16
/** ICO 目录里 256 写成 0，所以一帧最大就是 256 */
export const MAX_FRAME_SIZE = 256

export interface IcoFrame {
  /** 方图边长，1 – 256 */
  size: number
  png: Uint8Array
}

export interface IcoEntry {
  size: number
  offset: number
  bytes: number
  /** 帧内是不是 PNG（不是就是老式 BMP，这份标准不收） */
  png: boolean
  /** 目录里声明的位深 */
  bitCount: number
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

/** PNG 的 IHDR：宽高、位深、颜色类型；不是 PNG 就给 null */
export function readPngIhdr(bytes: Uint8Array): { width: number; height: number; bitDepth: number; colorType: number } | null {
  // 签名 8 + 长度 4 + 'IHDR' 4 + 宽 4 + 高 4 + 位深 1 + 颜色类型 1 = 30，缺一个字节就谈不上 IHDR
  if (!isPng(bytes) || bytes.length < 30) return null
  const at = 8 + 4 + 4
  return {
    width: (bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!,
    height: (bytes[at + 4]! << 24) | (bytes[at + 5]! << 16) | (bytes[at + 6]! << 8) | bytes[at + 7]!,
    bitDepth: bytes[at + 8]!,
    colorType: bytes[at + 9]!
  }
}

/** 拼出一份 .ico 的字节：帧按边长升序落进目录，与仓内那 12 张同序 */
export function buildIco(frames: readonly IcoFrame[]): Uint8Array {
  if (frames.length === 0) throw new Error('ico 至少要有一帧。')
  const sorted = [...frames].sort((a, b) => a.size - b.size)
  for (const frame of sorted) {
    if (!Number.isInteger(frame.size) || frame.size < 1 || frame.size > MAX_FRAME_SIZE) {
      throw new Error(`帧尺寸要在 1 – ${MAX_FRAME_SIZE} px 之间，收到 ${frame.size}`)
    }
  }
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.size === sorted[i - 1]!.size) {
      throw new Error(`同一个尺寸只能有一帧：${sorted[i]!.size} 出现了两次`)
    }
  }

  const total = HEADER_BYTES + sorted.length * ENTRY_BYTES + sorted.reduce((sum, f) => sum + f.png.length, 0)
  const out = new Uint8Array(total)
  const put16 = (at: number, v: number) => {
    out[at] = v & 0xff
    out[at + 1] = (v >> 8) & 0xff
  }
  const put32 = (at: number, v: number) => {
    out[at] = v & 0xff
    out[at + 1] = (v >> 8) & 0xff
    out[at + 2] = (v >> 16) & 0xff
    out[at + 3] = (v >>> 24) & 0xff
  }

  put16(2, 1) // 类型 1 = 图标（0 是光标）
  put16(4, sorted.length)

  let dataAt = HEADER_BYTES + sorted.length * ENTRY_BYTES
  sorted.forEach((frame, i) => {
    const ihdr = readPngIhdr(frame.png)
    if (!ihdr) throw new Error(`第 ${i + 1} 帧（${frame.size} px）不是 PNG`)
    if (ihdr.width !== frame.size || ihdr.height !== frame.size) {
      throw new Error(`第 ${i + 1} 帧写着 ${frame.size} px，图本身是 ${ihdr.width} × ${ihdr.height}`)
    }
    const entry = HEADER_BYTES + i * ENTRY_BYTES
    // 256 在目录里念 0（一个字节存不下）
    out[entry] = frame.size % 256
    out[entry + 1] = frame.size % 256
    out[entry + 2] = 0 // 调色板颜色数：32 位真彩写 0
    out[entry + 3] = 0
    put16(entry + 4, 0) // planes：实测那 12 张全是 0
    put16(entry + 6, 32)
    put32(entry + 8, frame.png.length)
    put32(entry + 12, dataAt)
    out.set(frame.png, dataAt)
    dataAt += frame.png.length
  })
  return out
}

/** 读回目录（存的这一刻自检用：界面念得出"7 帧，每帧 32 位 PNG"就是靠它） */
export function describeIco(bytes: Uint8Array): IcoEntry[] {
  if (bytes.length < HEADER_BYTES) throw new Error('这不是 ico：连头都读不出来。')
  if (bytes[0] !== 0 || bytes[1] !== 0 || bytes[2] !== 1 || bytes[3] !== 0) {
    throw new Error('这不是 ico：头的保留字节或类型对不上（图标应当是 0,0,1,0）。')
  }
  const count = bytes[4]! | (bytes[5]! << 8)
  const get32 = (at: number): number =>
    bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16) + bytes[at + 3]! * 0x1000000
  const entries: IcoEntry[] = []
  for (let i = 0; i < count; i++) {
    const entry = HEADER_BYTES + i * ENTRY_BYTES
    entries.push({
      size: (bytes[entry] ?? 0) || 256,
      offset: get32(entry + 12),
      bytes: get32(entry + 8),
      png: isPng(bytes.subarray(get32(entry + 12), get32(entry + 12) + 8)),
      bitCount: bytes[entry + 6]! | (bytes[entry + 7]! << 8)
    })
  }
  return entries
}

/** 目录摘要那句话的措辞：7 帧 → 「16/24/32/48/64/128/256」 */
export function frameSizesPhrase(entries: readonly IcoEntry[]): string {
  return entries.map((e) => e.size).join('/')
}
