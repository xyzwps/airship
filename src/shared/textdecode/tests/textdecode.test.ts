import { describe, expect, it } from 'vitest'
import { decodeText } from '@shared/textdecode'

/**
 * TD 册子（docs/specs/textdecode.md）里那三条"没有 BOM 就露馅"的场景。
 * TD-001 / TD-004 / TD-005 / TD-006 收编在 src/shared/textdecode/__tests__/decode.test.ts。
 */

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('BOM 判在编码尝试之前', () => {
  it('TD-002 带 UTF-16BE BOM 的文件同样按 BOM 判', () => {
    // "网络" 的 UTF-16BE 字节：7F51 7EDC
    const bytes = new Uint8Array([0xfe, 0xff, 0x7f, 0x51, 0x7e, 0xdc])
    expect(decodeText(bytes)).toBe('网络')
  })

  it('TD-003 BOM 判在 UTF-8 之前，原缺陷不再复现', () => {
    // "跅"（U+8DC5）的 UTF-16LE 字节是 C5 8D —— 恰好也是一段合法 UTF-8（解出 "ō"）。
    // 原 RN 版把 UTF-16 排在最后兜底，这一类文件就会被 UTF-8 "解成功" 骗过去。
    const withBom = new Uint8Array([0xff, 0xfe, 0xc5, 0x8d])
    const withoutBom = new Uint8Array([0xc5, 0x8d])
    expect(decodeText(withBom)).toBe('跅')
    // 同一串字节去掉 BOM：UTF-8 自称解成功了，交出来的却是另一个字
    expect(decodeText(withoutBom)).not.toBe('跅')
    expect(decodeText(withoutBom)).toBe('ō')
  })
})

describe('两种编码都对不上时不炸', () => {
  it('TD-007 UTF-8 与 GBK 都解不动时返回带替换字符的结果', () => {
    const bytes = new Uint8Array([0xff, 0xff, 0xff, ...utf8('尾部还是好的')])
    const out = decodeText(bytes)
    expect(typeof out).toBe('string')
    expect(out).toContain('\uFFFD')
    // 解不动的位置只吃掉它自己那几个字节，后面的内容照常读得出
    expect(out.endsWith('尾部还是好的')).toBe(true)
  })
})
