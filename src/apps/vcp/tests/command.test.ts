import { describe, expect, it } from 'vitest'
import { build, checks, display, swapExt, syncOutPath, type Fix, type Note } from '../command'
import { createState, type AppState, type ProbeInfo, type StreamInfo, type SubRef } from '../state'

/**
 * 移植自 Avalonia 版 Logic/SelfTest.cs 的 [5] 命令生成 与 [9] 图形字幕/封面流 两组纯逻辑用例。
 * 素材里没有的情况（蓝光 PGS、封面流）用合成流信息造，和原版做法一致。
 */

function st(
  idx: number,
  rel: number,
  type: string,
  codec: string,
  lang = '',
  def = false,
  pic = false,
  w = 0,
  h = 0,
  title = ''
): StreamInfo {
  return {
    index: idx,
    rel,
    type,
    lang,
    codec,
    w,
    h,
    fps: 0,
    channels: 0,
    sampleRate: 0,
    bitrate: 0,
    isDefault: def,
    forced: false,
    attachedPic: pic,
    title
  }
}

function demoProbe(): ProbeInfo {
  return {
    path: 'T:/4k_demo.mp4',
    name: '4k_demo.mp4',
    dir: 'T:',
    size: 1 << 20,
    duration: 4,
    durationText: '00:00:04',
    bitrate: 0,
    format: 'mov,mp4',
    streams: [
      st(0, 0, 'video', 'hevc', 'und', true, false, 3840, 2160),
      st(1, 0, 'audio', 'aac', 'chi', true),
      st(2, 1, 'audio', 'aac', 'eng')
    ]
  }
}

function withProbe(probe: ProbeInfo): AppState {
  const s = createState()
  s.probe = probe
  return s
}

function findFix(notes: Note[], level: Note['level'], fragment: string): Note | undefined {
  return notes.find((x) => x.level === level && x.msg.includes(fragment))
}

function applyFix(s: AppState, fix: Fix): void {
  // 与界面上的那颗一键修正是同一套：改完交给 syncOutPath 收拾输出名，规则不在这里重抄
  const containerBefore = s.out.container
  switch (fix.kind) {
    case 'vcodec':
      s.out.vcodec = fix.value
      break
    case 'acodec':
      s.out.acodec = fix.value
      break
    case 'scale-level':
      if (fix.value === 0) s.scale.on = false
      else {
        s.scale.on = true
        s.scale.p = fix.value
      }
      break
    case 'container':
      s.out.container = fix.value
      break
    case 'submode-soft':
      s.keep.subMode = 'soft'
      break
    case 'out-ext':
      s.out.path = swapExt(s.out.path, s.out.container)
      break
    case 'out-rename':
      break
  }
  syncOutPath(s, containerBefore)
}

describe('[5] 命令生成', () => {
  it('选流 / 缩放 / 像素格式 / 输出路径', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.scale.on = true
    s.scale.p = 1080
    s.out.path = 'T:/_selftest.mp4'

    const args = build(s)
    const cmd = display(args)

    expect(cmd).toContain('-map 0:v:0')
    // 用同类型相对序号，不是全局流号
    expect(cmd).toContain('-map 0:a:0')
    expect(cmd).toContain('-vf scale=-2:1080')
    expect(cmd).toContain('-pix_fmt yuv420p')
    expect(args[args.length - 1]).toBe(s.out.path)
  })

  it('VC-062 复制流 + 滤镜 → 报 error，一键修正改回 x264', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.scale.on = true
    s.scale.p = 1080
    s.out.path = 'T:/_selftest.mp4'
    s.out.vcodec = 'copy'

    const notes = checks(s, null)
    const note = findFix(notes, 'error', '直接复制')
    expect(note).toBeTruthy()
    expect(note!.fix).toBeTruthy()
    applyFix(s, note!.fix!)
    expect(s.out.vcodec).toBe('libx264')
  })

  it('补边小于源 / 放大 / 输出与源同名', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.out.path = 'T:/_selftest.mp4'

    s.pad.on = true
    s.pad.w = 1080
    s.pad.h = 1920
    expect(findFix(checks(s, null), 'error', 'Padded dimensions')).toBeTruthy()
    s.pad.on = false

    // 放大这一档界面上不给选（比源高的档位会跳过），批量套用到小源上时由检查区兜底念出来
    const small = withProbe({
      ...demoProbe(),
      streams: [st(0, 0, 'video', 'hevc', 'und', true, false, 854, 480)]
    })
    small.keep.videoRel = 0
    small.out.path = 'T:/_selftest.mp4'
    small.scale.on = true
    small.scale.p = 1080
    const up = findFix(checks(small, null), 'warn', '大于源高')
    expect(up?.msg).toBe('目标高 1080 大于源高 480，放大只会更糊、更大。')
    applyFix(small, up!.fix!)
    expect(small.scale.on).toBe(false)

    s.out.path = s.probe!.path
    expect(findFix(checks(s, null), 'error', '毁掉源文件')).toBeTruthy()
  })
})

describe('[9] 图形字幕与封面流（仿蓝光 REMUX）', () => {
  function pgsProbe(): ProbeInfo {
    return {
      path: 'D:/x/captain.mkv',
      name: 'captain.mkv',
      dir: 'D:/x',
      size: 1 << 30,
      duration: 100,
      durationText: '00:01:40',
      bitrate: 0,
      format: 'matroska',
      streams: [
        st(0, 0, 'video', 'hevc', 'eng', true, false, 3840, 2160),
        st(1, 0, 'audio', 'truehd', 'eng', true),
        st(5, 0, 'subtitle', 'hdmv_pgs_subtitle', 'chi', true),
        st(6, 1, 'subtitle', 'subrip', 'chi'),
        st(7, 1, 'video', 'mjpeg', '', false, true, 254, 254)
      ]
    }
  }

  it('封面流不算正片；PGS 认成图形字幕', () => {
    const pgs = pgsProbe()
    expect(pgs.streams.filter((x) => x.type === 'video' && !x.attachedPic).length).toBe(1)
    expect(pgs.streams[2]!.codec).toBe('hdmv_pgs_subtitle')
  })

  it('图形字幕 + mp4 → error，一键修正换 mkv 且路径跟着换', () => {
    const s = withProbe(pgsProbe())
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.out.path = 'D:/x/captain_1080p.mp4'

    const note = findFix(checks(s, null), 'error', '图形字幕')
    expect(note).toBeTruthy()
    applyFix(s, note!.fix!)
    expect(s.out.container).toBe('mkv')
    expect(s.out.path.endsWith('.mkv')).toBe(true)

    const args = build(s)
    const i = args.indexOf('-c:s')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('copy')
  })

  it('VC-013 混轨：图形轨 copy、文字轨 srt，逐轨指定', () => {
    const s = withProbe(pgsProbe())
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.keep.subs.push({ embedded: true, rel: 1, extId: 0, path: '', name: '' })
    s.out.container = 'mkv'
    s.out.path = 'D:/x/captain.mkv'

    const args = build(s)
    const i0 = args.indexOf('-c:s:0')
    const i1 = args.indexOf('-c:s:1')
    expect(i0).toBeGreaterThanOrEqual(0)
    expect(args[i0 + 1]).toBe('copy')
    expect(i1).toBeGreaterThanOrEqual(0)
    expect(args[i1 + 1]).toBe('srt')
  })

  it('图形字幕烧入 → error；纯文字字幕 mp4 用 mov_text', () => {
    const s = withProbe(pgsProbe())
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.keep.subMode = 'burn'
    s.out.path = 'D:/x/captain.mp4'
    expect(findFix(checks(s, null), 'error', '烧不进')).toBeTruthy()

    s.keep.subMode = 'soft'
    s.keep.subs = [{ embedded: true, rel: 1, extId: 0, path: '', name: '' }]
    s.out.container = 'mp4'
    const args = build(s)
    expect(args).toContain('mov_text')
    expect(findFix(checks(s, null), 'error', '图形字幕')).toBeFalsy()
  })
})

describe('字幕引用与占位', () => {
  it('没抽好的内嵌烧入字幕在命令里留占位', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' } as SubRef)
    s.out.path = 'T:/o.mp4'
    const args = build(s)
    expect(args.some((a) => a.includes('@EXTRACT@0'))).toBe(true)
  })

  it('抽好后用真实路径，不再留占位', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.extracted['s0'] = 'T:/tmp/sub.srt'
    s.out.path = 'T:/o.mp4'
    const args = build(s)
    expect(args.some((a) => a.includes('@EXTRACT@'))).toBe(false)
    expect(args.some((a) => a.includes('subtitles=filename='))).toBe(true)
  })
})

describe('输出名永远跟着容器走', () => {
  it('VC-074 后缀跟着容器换：主名不动，没后缀就补，整条是目录就不动', () => {
    expect(swapExt('T:/media/片源.mp4', 'mkv')).toBe('T:/media/片源.mkv')
    expect(swapExt('T:\\media\\片源', 'mp4')).toBe('T:\\media\\片源.mp4')
    expect(swapExt('T:/media/a.b.c.mkv', 'mp4')).toBe('T:/media/a.b.c.mp4')
    expect(swapExt('T:/media/', 'mp4')).toBe('T:/media/')
    expect(swapExt('', 'mp4')).toBe('')

    // 手敲过的主名保留，只换后缀
    const touched = withProbe(demoProbe())
    touched.out.path = 'T:/media/我起的名字.mp4'
    touched.out.pathTouched = true
    touched.out.container = 'mkv'
    syncOutPath(touched, 'mp4')
    expect(touched.out.path).toBe('T:/media/我起的名字.mkv')

    // 没手敲过 → 整条按当前配置重算
    const auto = withProbe(demoProbe())
    auto.out.container = 'mkv'
    syncOutPath(auto, 'mp4')
    expect(auto.out.path).toBe('T:/4k_demo.mkv')

    // 手敲过、这一次又不是在换容器 → 一个字都不动
    const kept = withProbe(demoProbe())
    kept.out.path = 'T:/media/我起的名字.avi'
    kept.out.pathTouched = true
    kept.scale.on = true
    kept.scale.p = 1080
    syncOutPath(kept, 'mp4')
    expect(kept.out.path).toBe('T:/media/我起的名字.avi')
  })

  it('VC-075 后缀与容器不符：warn 说清产物会是哪一个，一键换成容器后缀', () => {
    const s = withProbe(demoProbe())
    s.keep.videoRel = 0
    s.out.path = 'T:/片源.avi'
    s.out.pathTouched = true

    const note = findFix(checks(s, null), 'warn', '后缀是 .avi')
    expect(note?.msg).toBe('输出名后缀是 .avi，容器选的却是 mp4：ffmpeg 按后缀认容器，产物会是 .avi。')
    expect(note?.fixLabel).toBe('换成 .mp4')
    applyFix(s, note!.fix!)
    expect(s.out.path).toBe('T:/片源.mp4')
    expect(findFix(checks(s, null), 'warn', '后缀是')).toBeFalsy()

    // 一个后缀都没有 → 说的是"补上"
    s.out.path = 'T:/片源'
    expect(findFix(checks(s, null), 'warn', '没有后缀')?.fixLabel).toBe('补上 .mp4')
  })
})
