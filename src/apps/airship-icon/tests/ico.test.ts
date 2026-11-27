import { describe, expect, it } from 'vitest'
import { buildIco, describeIco, frameSizesPhrase, ICON_FRAME_SIZES, isPng, readPngIhdr } from '../ico.ts'
import { PNG_SIGNATURE, squarePng } from './helpers/png.ts'

/**
 * ICO 容器层的判据（册子：specs/airship-icon.md 的「出的 icon.ico 是标准那 7 帧」）。
 * 字段值取自仓内 12 张真 ico 的实测，见 docs/apps/icons.md 与 ico.ts 的头注。
 */
function frames(sizes: readonly number[]) {
  return sizes.map((size) => ({ size, png: squarePng(size) }))
}

describe('拼一份 ico', () => {
  it('IC-012 帧按边长升序落进目录，256 在目录里念 0，每帧 32 位且帧内是 PNG', () => {
    const bytes = buildIco(frames([256, 16, 128, 48, 64, 24, 32]))
    const entries = describeIco(bytes)

    expect(frameSizesPhrase(entries)).toBe('16/24/32/48/64/128/256')
    expect(entries.every((e) => e.bitCount === 32)).toBe(true)
    expect(entries.every((e) => e.png)).toBe(true)
    // 目录里那两字节存不下 256，标准写法是 0；读回函数把它换算回来
    expect(bytes[6]).toBe(16)
    expect(bytes[6 + 6 * 16]).toBe(0)
    // 首帧紧跟在 6 + 7×16 那行目录之后，与仓内那张 templates/app/icon.ico 同形
    expect(entries[0]!.offset).toBe(6 + 7 * 16)
    expect(entries.reduce((sum, e) => sum + e.bytes, 0) + entries[0]!.offset).toBe(bytes.length)
  })

  it('IC-014 一帧都没有就不出文件', () => {
    expect(() => buildIco([])).toThrow('ico 至少要有一帧。')
  })

  it('IC-015 同一个尺寸只许一帧', () => {
    expect(() => buildIco(frames([32, 32]))).toThrow('同一个尺寸只能有一帧：32 出现了两次')
  })

  it('IC-016 帧内不是 PNG 就点名第几帧', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0])
    expect(() => buildIco([{ size: 32, png: jpeg }])).toThrow('第 1 帧（32 px）不是 PNG')
  })

  it('IC-017 目录写的尺寸与图本身不符就拒', () => {
    expect(() => buildIco([{ size: 32, png: squarePng(16) }])).toThrow('第 1 帧写着 32 px，图本身是 16 × 16')
  })

  it('IC-018 帧尺寸出格就报收到的数', () => {
    expect(() => buildIco([{ size: 300, png: squarePng(300) }])).toThrow('帧尺寸要在 1 – 256 px 之间，收到 300')
  })

  it('IC-019 头对不上的文件不当 ico 读', () => {
    expect(() => describeIco(Uint8Array.from([0, 0, 2, 0, 1, 0]))).toThrow(
      '这不是 ico：头的保留字节或类型对不上（图标应当是 0,0,1,0）。'
    )
    expect(() => describeIco(new Uint8Array(3))).toThrow('这不是 ico：连头都读不出来。')
  })
})

describe('PNG 的那点底子', () => {
  it('工装造的这张图有真签名与真 IHDR', () => {
    const png = squarePng(48)
    expect(Array.from(png.slice(0, 8))).toEqual(PNG_SIGNATURE)
    expect(isPng(png)).toBe(true)
    expect(readPngIhdr(png)).toEqual({ width: 48, height: 48, bitDepth: 8, colorType: 6 })
    expect(ICON_FRAME_SIZES).toEqual([16, 24, 32, 48, 64, 128, 256])
  })
})
