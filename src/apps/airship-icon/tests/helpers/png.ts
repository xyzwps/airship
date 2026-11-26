import { deflateSync } from 'node:zlib'

/**
 * 造一张真 PNG（RGBA 8 位、纯色），给容器层与界面层用例当帧内容。
 *
 * 为什么要真签名 + 真 IHDR：`ico.ts` 判的就是这两样（还有一帧的尺寸要与目录相符），
 * 拿一串假字节喂进去等于把判据跳过。像素是 deflate 出来的合法 IDAT，
 * 所以这张图连浏览器与 ImageMagick 都读得开——"画得对不对"仍归截图走查，这里只管容器。
 */
export const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = -1
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length)
  body.set(typeBytes(type), 0)
  body.set(data, 4)
  const out = new Uint8Array(8 + body.length + 4)
  const len = data.length
  out[0] = (len >>> 24) & 0xff
  out[1] = (len >>> 16) & 0xff
  out[2] = (len >>> 8) & 0xff
  out[3] = len & 0xff
  out.set(body, 4)
  const crc = crc32(body)
  out[4 + body.length] = (crc >>> 24) & 0xff
  out[5 + body.length] = (crc >>> 16) & 0xff
  out[6 + body.length] = (crc >>> 8) & 0xff
  out[7 + body.length] = crc & 0xff
  return out
}

function typeBytes(type: string): Uint8Array {
  return Uint8Array.from([...type].map((c) => c.charCodeAt(0)))
}

function be32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

export function squarePng(size: number, rgba: readonly number[] = [26, 111, 193, 255]): Uint8Array {
  const ihdr = new Uint8Array([...be32(size), ...be32(size), 8, 6, 0, 0, 0])
  const raw = new Uint8Array(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0 // 每行行首的滤波字节
    for (let x = 0; x < size; x++) raw.set(rgba, row + 1 + x * 4)
  }
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
