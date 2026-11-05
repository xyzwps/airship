import { describe, expect, it } from 'vitest'
import { parseProbe, parseStreams, subSnippet } from '../probe'

/**
 * 移植自 SelfTest.cs [3c] 字幕开头文字，以及 [3b] 轨道名解析。
 * [3b] 原版跑真实 multi_sub.mkv；这里用合成的 ffmpeg stderr 文本，
 * 断言的是解析器本身（title / language / 不串流），不依赖素材。
 */

const STDERR = `Input #0, matroska,webm, from 'multi_sub.mkv':
  Duration: 00:00:10.00, start: 0.000000, bitrate: 75 kb/s
  Stream #0:0: Video: hevc (Main), yuv420p(tv), 1920x1080, 25 fps, 25 tbr, 1k tbn
  Stream #0:1(eng): Subtitle: subrip (default)
    Metadata:
      title           : English
  Stream #0:2(chi): Subtitle: subrip
    Metadata:
      title           : 简体中文
  Stream #0:3(jpn): Subtitle: subrip
`

describe('[3c] 字幕开头文字', () => {
  it('srt：取前两句、去掉 <i> 标签', () => {
    expect(
      subSnippet(
        '1\n00:00:00,000 --> 00:00:02,000\n第一条\n\n2\n00:00:02,000 --> 00:00:04,000\nsecond <i>line</i>\n\n3\n'
      )
    ).toBe('第一条 ／ second line')
  })

  it('ass：只取 Dialogue 的文本列，去掉 {} 和 \\N', () => {
    expect(
      subSnippet(
        '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\an2}中文第一句\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,第二句\\N换行\n'
      )
    ).toBe('中文第一句 ／ 第二句 换行')
  })

  it('vtt：跳过 WEBVTT/Kind 头', () => {
    expect(subSnippet('WEBVTT\nKind: subtitles\nLanguage: en\n\n00:00:00.000 --> 00:00:02.000\nhello there\n')).toBe(
      'hello there'
    )
  })
})

describe('[3b] 轨道名解析', () => {
  it('语言码与 Metadata title（含中文）', () => {
    const streams = parseStreams(STDERR)
    const subs = streams.filter((s) => s.type === 'subtitle')
    expect(subs.length).toBe(3)
    expect(subs.map((s) => s.lang).join(',')).toBe('eng,chi,jpn')
    expect(subs.map((s) => s.title).join(',')).toBe('English,简体中文,')
  })

  it('title 没串到别的流上', () => {
    const streams = parseStreams(STDERR)
    expect(
      streams
        .filter((s) => s.type !== 'subtitle')
        .map((s) => s.title)
        .join(',')
    ).toBe('')
  })

  it('parseProbe 取时长与格式', () => {
    const info = parseProbe(STDERR, { path: 'T:/multi_sub.mkv', name: 'multi_sub.mkv', dir: 'T:', size: 1 })
    expect(info.duration).toBe(10)
    // 格式只取到第一个逗号，和原版正则一致
    expect(info.format).toBe('matroska')
    expect(info.streams.length).toBe(4)
  })
})
