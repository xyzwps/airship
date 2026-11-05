import { describe, expect, it } from 'vitest'
import { parseImages, pullIsUpToDate, splitLogLines } from '../parse'
import { imageCreatedText, imageSizeText, imageSubtleLine, imageUsageText } from '../model'
import { fixture } from '@tests/helpers/fakeAirship'
import type { RawImage } from '../parse'

/**
 * 字段翻译（node 环境）：wslc 写的时刻与大小要变成人读的话，读不动时不空着也不报错。
 */

const BLANK: RawImage = {
  id: 'aaef90e06523',
  repository: 'docker.1ms.run/library/busybox',
  tag: 'latest',
  size: '',
  createdAt: '',
  createdSince: '',
  containers: '',
  digest: '<none>'
}

/** 本地 年-月-日 时:分 —— 由用例自己按同一时刻换算，钉住的是"换算到本地"这件事 */
function localStamp(utcMs: number): string {
  const d = new Date(utcMs)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

describe('镜像字段的读法', () => {
  it('IM-007 创建时间与大小按人能读的样子写，解析不动就原样站着', () => {
    // 真样本里那格写的是 "2026-05-13 10:21:49 +0800 GMT+8"，末尾的时区名会把通用解析器带糊涂
    const [busybox] = parseImages(fixture('wslc/wslc-images.ndjson'))
    const shown = imageCreatedText(busybox!)
    expect(shown).toBe(localStamp(Date.UTC(2026, 4, 13, 10, 21, 49) - 8 * 60 * 60 * 1000))

    // 认不出来的时刻：退回相对时间，再不行原样显示，总之不空着
    expect(imageCreatedText({ ...BLANK, createdAt: '很久以前', createdSince: '3 weeks ago' })).toBe('3 weeks ago')
    expect(imageCreatedText({ ...BLANK, createdAt: '很久以前', createdSince: '' })).toBe('很久以前')
    expect(imageCreatedText({ ...BLANK, createdAt: '', createdSince: '' })).toBe('—')

    // 大小照 wslc 给的写法读，没有就给横杠
    expect(imageSizeText(busybox!)).toBe('4.45MB')
    expect(imageSizeText(BLANK)).toBe('—')
    expect(imageSubtleLine(busybox!)).toBe(`ID aaef90e06523 · 创建 ${shown}`)
  })

  it('IM-003 IM-004 引用数认得出数字就报引用，认不出就按没人用说', () => {
    expect(imageUsageText({ ...BLANK, containers: '2' })).toBe('被 2 个容器引用')
    expect(imageUsageText({ ...BLANK, containers: '12' })).toBe('被 12 个容器引用')
    for (const raw of ['N/A', '', '  ', '两个', '0']) {
      expect(imageUsageText({ ...BLANK, containers: raw })).toBe('未被容器引用')
    }
    // 数字写成数字（不是字符串）也照样读得进
    const loose = parseImages('{"ID":"aaef90e06523","Repository":"r","Tag":"t","Containers":3}')
    expect(imageUsageText(loose[0]!)).toBe('被 3 个容器引用')
  })

  it('WL-008 末尾的空尾巴不算一行，中间空行留着', () => {
    expect(splitLogLines('')).toEqual([])
    expect(splitLogLines('\n\n')).toEqual([])
    expect(splitLogLines('a\nb\n')).toEqual(['a', 'b'])
    expect(splitLogLines('a\r\n\r\nb\r\n')).toEqual(['a', '', 'b'])
  })

  it('IM-011 IM-012 IM-013 拉取结果分得清“新下载”、“已是最新”与没有 Status 行', () => {
    // 这两份都是 wslc 3.0.1 的真输出
    expect(pullIsUpToDate(fixture('wslc/wslc-pull-new.txt'))).toBe(false)
    expect(pullIsUpToDate(fixture('wslc/wslc-pull-uptodate.txt'))).toBe(true)
    // 找不到 Status 行不算错误：按"真下载了"说，不谎报
    expect(pullIsUpToDate('latest: Pulling from library/busybox\n')).toBe(false)
    expect(pullIsUpToDate('')).toBe(false)
  })
})
