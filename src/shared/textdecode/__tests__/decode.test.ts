import { describe, expect, it } from 'vitest'
import { decodeText } from '../index'

/** 中文文本解码：BOM 优先、GBK 回退。墨读解 TXT 与 vcp 解字幕共用这套逻辑。 */

describe('编码识别', () => {
  it('UTF-8 直接解', () => {
    expect(decodeText(new TextEncoder().encode('测试书'))).toBe('测试书')
  })

  it('GBK 回退（国内下载的 TXT 常见）', () => {
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) // "中文" 的 GBK 字节
    expect(decodeText(gbk)).toBe('中文')
  })

  it('UTF-16LE 靠 BOM 认出（不带 BOM 会被当成 UTF-8 解出乱码）', () => {
    // "网络" 的 UTF-16LE 字节：51 7F DC 7E
    const withBom = new Uint8Array([0xff, 0xfe, 0x51, 0x7f, 0xdc, 0x7e])
    expect(decodeText(withBom)).toBe('网络')
  })

  it('UTF-8 BOM 要剥掉，别让文档开头带一个不可见字符', () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('第一章 起风了')])
    expect(decodeText(withBom)).toBe('第一章 起风了')
  })
})
