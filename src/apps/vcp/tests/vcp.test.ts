import { describe, expect, it } from 'vitest'
import { build, checks, defaultOutPath, display, fpath, audioFilters, videoFilters, type Note } from '@apps/vcp/command'
import { detailText, forTarget, fromState, JobQueue, statusText, uniquePath, type JobSpec } from '@apps/vcp/jobs'
import { feedProgress } from '@apps/vcp/runner'
import { createState, type AppState, type ProbeInfo, type StreamInfo } from '@apps/vcp/state'

/**
 * VC 册子（src/apps/vcp/specs/vcp.md）里"命令与队列"那几条：纯函数，不碰界面也不碰真 ffmpeg。
 * 更早从 Avalonia 版搬来的那批（command/probe/jobs 三份）在 tests/ 旁边，
 * 钉的是同一批契约的用例已挂上编号，没挂的是册子里还没立条的历史覆盖。
 */

function st(index: number, rel: number, type: string, codec: string, over: Partial<StreamInfo> = {}): StreamInfo {
  return {
    index,
    rel,
    type,
    lang: '',
    codec,
    w: 0,
    h: 0,
    fps: 0,
    channels: 0,
    sampleRate: 0,
    bitrate: 0,
    isDefault: false,
    forced: false,
    attachedPic: false,
    title: '',
    ...over
  }
}

function probe(streams: StreamInfo[], over: Partial<ProbeInfo> = {}): ProbeInfo {
  return {
    path: 'T:/media/片源.mp4',
    name: '片源.mp4',
    dir: 'T:/media',
    size: 1 << 20,
    duration: 100,
    durationText: '00:01:40',
    bitrate: 5000,
    format: 'mov,mp4',
    streams,
    ...over
  }
}

const FULL = (): ProbeInfo =>
  probe([
    st(0, 0, 'video', 'hevc', { w: 3840, h: 2160, fps: 25 }),
    st(1, 0, 'audio', 'aac', { lang: 'chi', isDefault: true }),
    st(2, 1, 'audio', 'aac', { lang: 'eng' }),
    st(3, 0, 'subtitle', 'subrip', { lang: 'chi' }),
    st(4, 1, 'subtitle', 'hdmv_pgs_subtitle', { lang: 'eng' })
  ])

function opened(p: ProbeInfo = FULL()): AppState {
  const s = createState()
  s.probe = p
  s.keep.videoRel = 0
  s.keep.audioRels.push(0)
  s.out.path = 'T:/media/片源.mp4.out.mp4'
  return s
}

function noteOf(notes: Note[], level: Note['level'], fragment: string): Note | undefined {
  return notes.find((n) => n.level === level && n.msg.includes(fragment))
}

function indexOfPair(args: string[], flag: string): string {
  const i = args.indexOf(flag)
  return i < 0 ? '' : args[i + 1]!
}

describe('保留哪些流', () => {
  it('VC-009 不要画面就 -vn，不要声音就 -an', () => {
    const s = opened()
    s.keep.videoRel = null
    s.keep.audioRels = []
    const args = build(s)
    expect(args).toContain('-vn')
    expect(args).toContain('-an')
    expect(args).not.toContain('-map')

    const only = opened()
    only.keep.audioRels = []
    const second = build(only)
    expect(second).toContain('-map')
    expect(second).toContain('-an')
    expect(second).not.toContain('-vn')
  })

  it('VC-010 保留音频的条数决定有几条 -map 0:a', () => {
    const s = opened()
    s.keep.audioRels = [0, 1]
    const args = build(s)
    expect(args.filter((a) => a === '-map')).toHaveLength(3)
    expect(args).toContain('0:a:0')
    expect(args).toContain('0:a:1')
  })

  it('VC-011 内嵌软字幕的 map 是同类型相对序号', () => {
    const s = opened()
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.keep.subMode = 'soft'
    const args = build(s)
    expect(args).toContain('0:s:0')
  })

  it('VC-012 外挂字幕按 -i 出现的顺序编号，map 用的是那个输入序号', () => {
    const s = opened()
    s.extSubs.push(
      { embedded: false, rel: 0, extId: 0, path: 'T:/media/第一份.srt', name: '' },
      { embedded: false, rel: 0, extId: 1, path: 'T:/media/第二份.srt', name: '' }
    )
    s.keep.subs.push({ embedded: false, rel: 0, extId: 1, path: 'T:/media/第二份.srt', name: '' })
    s.keep.subMode = 'soft'
    const args = build(s)

    // 源文件是第一份输入，两份外挂依次跟在后面 → 第二份外挂是输入 2
    expect(args.filter((a) => a === '-i')).toHaveLength(3)
    expect(args[args.indexOf('-i', args.indexOf('-i') + 1) + 1]).toBe('T:/media/第一份.srt')
    expect(args).toContain('2:s:0')
    expect(args).not.toContain('1:s:0')
  })

  it('VC-013 图形字幕在 mkv 里只能原样复制', () => {
    const s = opened()
    s.out.container = 'mkv'
    s.keep.subs.push({ embedded: true, rel: 1, extId: 0, path: '', name: '' })
    s.keep.subMode = 'soft'
    expect(indexOfPair(build(s), '-c:s')).toBe('copy')
  })
})

describe('处理链进命令', () => {
  it('VC-014 开关开着的才进 -vf，顺序是缩放、补边、色彩、水印、帧率', () => {
    const s = opened()
    s.scale.on = true
    s.scale.p = 1080
    s.fps.on = true
    s.fps.v = 30
    s.eq.on = true
    const vf = videoFilters(s)
    expect(vf).toEqual(['scale=-2:1080', 'eq=brightness=0:contrast=1:saturation=1', 'fps=fps=30'])
    expect(display(build(s))).toContain('-vf scale=-2:1080,eq=brightness=0:contrast=1:saturation=1,fps=fps=30')

    const off = opened()
    expect(videoFilters(off)).toEqual([])
    expect(build(off)).not.toContain('-vf')
  })

  it('VC-015 快速定位把 -ss 放在输入之前，慢定位放在之后，-to 总在输入之后', () => {
    const fast = opened()
    fast.trim.on = true
    fast.trim.ss = '00:01:00'
    fast.trim.to = '00:02:30'
    fast.trim.fast = true
    const a = build(fast)
    expect(a.indexOf('-ss')).toBeLessThan(a.indexOf('-i'))
    expect(a.indexOf('-to')).toBeGreaterThan(a.indexOf('-i'))

    const slow = opened()
    slow.trim.on = true
    slow.trim.ss = '00:01:00'
    slow.trim.fast = false
    const b = build(slow)
    expect(b.indexOf('-ss')).toBeGreaterThan(b.indexOf('-i'))
    expect(b.filter((x) => x === '-ss')).toHaveLength(1)
  })

  it('VC-016 滤镜里的路径是正斜杠、冒号转义、单引号包住', () => {
    expect(fpath('C:/Windows/Fonts/msyh.ttc')).toBe("'C\\:/Windows/Fonts/msyh.ttc'")
    expect(fpath('T:\\字幕\\第一份.srt')).toBe("'T\\:/字幕/第一份.srt'")
    const s = opened()
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: false, rel: 0, extId: 0, path: 'C:/字幕 第一.srt', name: '' })
    expect(display(build(s))).toContain("subtitles=filename='C\\:/字幕 第一.srt'")
  })

  it('VC-017 水印默认字体与四角位置', () => {
    const s = opened()
    s.text.on = true
    s.text.t = '我的水印'
    s.text.pos = '右上'
    const vf = videoFilters(s)
    expect(vf[0]).toContain("drawtext=text='我的水印'")
    expect(vf[0]).toContain("'C\\:/Windows/Fonts/msyh.ttc'")
    expect(vf[0]).toContain('x=w-tw-24:y=24')
  })

  it('VC-018 音量与响度串成两个滤镜，但一条音频都没留时不发 -af', () => {
    const s = opened()
    s.vol.on = true
    s.vol.v = 2
    s.loud.on = true
    expect(audioFilters(s)).toEqual(['volume=2', 'loudnorm=I=-16:TP=-1.5:LDI=11'])
    expect(build(s)).toContain('-af')

    s.keep.audioRels = []
    expect(build(s)).not.toContain('-af')
  })
})

describe('编码、容器与输出名', () => {
  it('VC-019 nvenc 用 -cq，x264 这类用 -crf，直接复制两个都不给', () => {
    const s = opened()
    s.out.vcodec = 'libx264'
    s.out.crf = '23'
    expect(indexOfPair(build(s), '-crf')).toBe('23')
    expect(build(s)).not.toContain('-cq')

    const nv = opened()
    nv.out.vcodec = 'hevc_nvenc'
    nv.out.crf = '23'
    expect(indexOfPair(build(nv), '-cq')).toBe('23')
    expect(build(nv)).not.toContain('-crf')

    const cp = opened()
    cp.out.vcodec = 'copy'
    expect(build(cp)).not.toContain('-crf')
    expect(build(cp)).not.toContain('-cq')
    expect(build(cp)).not.toContain('-preset')
  })

  it('VC-020 像素格式与 faststart 各自的条件', () => {
    const mp4 = opened()
    expect(build(mp4)).toContain('-pix_fmt')
    expect(build(mp4)).toContain('-movflags')

    // 直接复制画面：不重排像素、也不重排 moov
    const copy = opened()
    copy.out.vcodec = 'copy'
    expect(build(copy)).not.toContain('-pix_fmt')
    expect(build(copy)).not.toContain('-movflags')

    // 不是 mp4 容器不加 faststart
    const mkv = opened()
    mkv.out.container = 'mkv'
    expect(build(mkv)).not.toContain('-movflags')

    // 没保留画面就没有像素格式
    const noVideo = opened()
    noVideo.keep.videoRel = null
    expect(build(noVideo)).not.toContain('-pix_fmt')
  })

  it('VC-021 音频码率只在重编码音频时给，附加参数排在输出路径之前，输出路径永远最后一位', () => {
    const s = opened()
    s.out.extra = '-max_muxing_queue_size 1024'
    const args = build(s)
    expect(indexOfPair(args, '-b:a')).toBe('192k')
    expect(args).toContain('-max_muxing_queue_size')
    expect(args[args.length - 1]).toBe('T:/media/片源.mp4.out.mp4')

    const copyAudio = opened()
    copyAudio.out.acodec = 'copy'
    expect(build(copyAudio)).not.toContain('-b:a')

    const empty = opened()
    empty.out.path = ''
    expect(build(empty)[build(empty).length - 1]).toBe('out.mp4')
  })

  it('VC-022 命令行显示：带空格或引号的参数加双引号，里面的引号要转义', () => {
    expect(display(['-i', 'T:/a b.mp4'])).toBe('ffmpeg -i "T:/a b.mp4"')
    expect(display(['-vf', `drawtext=text='说"唱"'`])).toBe('ffmpeg -vf "drawtext=text=\'说\\"唱\\"\'"')
    expect(display(['-y', '-an'])).toBe('ffmpeg -y -an')
  })

  it('VC-023 输出名里的档位：开着写 _1080p 或 _2160p，关着不带那一截', () => {
    const p1080 = opened()
    p1080.scale.on = true
    p1080.scale.p = 1080
    defaultOutPath(p1080)
    expect(p1080.out.path).toBe('T:/media/片源_1080p.mp4')

    const p2160 = opened()
    p2160.scale.on = true
    p2160.scale.p = 2160
    defaultOutPath(p2160)
    expect(p2160.out.path).toBe('T:/media/片源_2160p.mp4')

    // 没开缩放 → 名字里不带那一截
    const plain = opened()
    defaultOutPath(plain)
    expect(plain.out.path).toBe('T:/media/片源.mp4')
  })
})

describe('检查', () => {
  it('VC-025 还没打开视频时只念那一句', () => {
    const s = createState()
    expect(checks(s, null)).toEqual([{ level: 'error', msg: '还没有打开视频。' }])
  })

  it('VC-026 没填输出路径', () => {
    const s = opened()
    s.out.path = ''
    expect(noteOf(checks(s, null), 'error', '没填输出路径')?.msg).toBe('没填输出路径。')
  })

  it('VC-027 一条流都没保留', () => {
    const s = opened()
    s.keep.videoRel = null
    s.keep.audioRels = []
    expect(noteOf(checks(s, null), 'error', '空文件')?.msg).toBe('一条流都没保留，输出会是空文件。')
  })

  it('VC-028 音频直接复制却要加音量：报 error 并给"改用 aac"', () => {
    const s = opened()
    s.out.acodec = 'copy'
    s.vol.on = true
    const note = noteOf(checks(s, null), 'error', '直接复制')
    expect(note?.msg).toBe('音量/响度滤镜需要重编码音频，当前音频是直接复制。')
    expect(note?.fixLabel).toBe('改用 aac')
    s.out.acodec = note!.fix!.kind === 'acodec' ? note!.fix!.value : s.out.acodec
    expect(noteOf(checks(s, null), 'error', '直接复制')).toBeUndefined()
  })

  it('VC-029 音量与响度同开只是提醒，不挡执行', () => {
    const s = opened()
    s.vol.on = true
    s.loud.on = true
    const note = noteOf(checks(s, null), 'warn', '归一会盖过')
    expect(note?.msg).toBe('音量和响度归一同时开，归一会盖过手动倍数。')
    expect(note?.fixLabel).toBeUndefined()
  })

  it('VC-030 结束时间不晚于开始时间就报错，两个时间相等也算', () => {
    const s = opened()
    s.trim.on = true
    s.trim.ss = '00:02:00'
    s.trim.to = '00:01:30'
    expect(noteOf(checks(s, null), 'error', '结束时间早于开始时间')?.msg).toBe('结束时间早于开始时间。')

    s.trim.to = '00:02:00'
    expect(noteOf(checks(s, null), 'error', '结束时间早于开始时间')?.msg).toBe('结束时间早于开始时间。')

    s.trim.to = '00:02:01'
    expect(noteOf(checks(s, null), 'error', '结束时间早于开始时间')).toBeUndefined()
  })

  it('VC-031 输出已存在：念出大小，一键"另存为新名"换个名字', () => {
    const s = opened()
    s.out.path = 'T:/media/已存在.mp4'
    const note = noteOf(checks(s, { size: 5 * 1048576 }), 'warn', '输出文件已存在')
    expect(note?.msg).toBe('输出文件已存在（5.0 MB），执行会直接覆盖。')
    expect(note?.fixLabel).toBe('另存为新名')
    expect(noteOf(checks(s, null), 'warn', '输出文件已存在')).toBeUndefined()
  })

  it('VC-032 输出与源同名（大小写与斜杠不同也算）', () => {
    const s = opened(probe(FULL().streams, { path: 'T:/media/片源.mp4' }))
    s.out.path = 't:\\media\\片源.mp4'
    expect(noteOf(checks(s, null), 'error', '毁掉源文件')?.msg).toBe('输出路径与源文件相同，会毁掉源文件。')
  })

  it('VC-038 mp4 装文字软字幕只是提醒，一键换成 mkv', () => {
    const s = opened()
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.keep.subMode = 'soft'
    const info = noteOf(checks(s, null), 'info', 'mov_text')
    expect(info?.fixLabel).toBe('换成 mkv')
    const bitmap = noteOf(checks(s, null), 'error', '装不下')
    expect(bitmap).toBeUndefined()
  })

  it('VC-039 烧内嵌字幕前会先抽成临时文件，这条写给用户看', () => {
    const s = opened()
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    expect(noteOf(checks(s, null), 'info', '先抽成临时 srt')).toBeTruthy()
  })

  it('VC-040 源是 4K 又没开缩放，提醒 CPU 编码会慢', () => {
    const s = opened()
    expect(noteOf(checks(s, null), 'info', '4K')?.fixLabel).toBe('降到 1080p')
    s.scale.on = true
    s.scale.p = 1080
    expect(noteOf(checks(s, null), 'info', '4K')).toBeUndefined()
  })

  it('VC-041 一处问题都没有时不产生任何提示', () => {
    const s = opened(probe([st(0, 0, 'video', 'hevc', { w: 1920, h: 1080 })]))
    s.out.path = 'T:/media/新名字.mkv'
    s.out.container = 'mkv'
    s.keep.subs = []
    expect(checks(s, null)).toEqual([])
  })
})

describe('队列里的状态怎么说', () => {
  function job(over: Partial<JobSpec> = {}) {
    return {
      id: 'j1',
      no: 1,
      title: '片源.mp4',
      args: [],
      outPath: 'T:/media/片源.mp4',
      durationSec: 100,
      tempFiles: [],
      state: 'queued' as const,
      error: '',
      note: '',
      outSize: 0,
      pct: 0,
      speed: '',
      startedAt: null,
      finishedAt: null,
      ...over
    }
  }

  it('VC-042 六种状态各念各的那句', () => {
    expect(statusText(job())).toBe('排队中')
    expect(statusText(job({ state: 'running' }))).toBe('启动中')
    expect(statusText(job({ state: 'running', startedAt: Date.now() - 1000, pct: 42 }))).toBe('进行中 42%')
    expect(statusText(job({ state: 'done', outSize: 5 * 1048576 }))).toBe('已完成 5.0 MB')
    expect(statusText(job({ state: 'error' }))).toBe('失败')
    expect(statusText(job({ state: 'killed' }))).toBe('已停止')
    expect(statusText(job({ state: 'cancelled' }))).toBe('已取消')
  })

  it('VC-043 进行中那一栏念得出倍速、还剩多久与已用多久', () => {
    const j = job({ state: 'running', startedAt: Date.now() - 10_000, pct: 50, speed: '2.50x' })
    const text = detailText(j)
    expect(text).toContain('2.50x')
    expect(text).toContain('约剩 0:10')
    expect(text).toContain('已用 10 秒')
    // 刚开始还估不出剩余
    expect(detailText(job({ state: 'running', startedAt: Date.now() - 1000, pct: 1 }))).toBe('已用 1 秒')
  })

  it('VC-044 失败那一栏念最后一行报错，一句报错都没有就念"失败"', () => {
    expect(detailText(job({ state: 'error', error: '第一行\nerror: 输出写不进去\n' }))).toBe('error: 输出写不进去')
    expect(detailText(job({ state: 'error', error: '\n  \n' }))).toBe('失败')
    expect(detailText(job({ note: '输出撞名，改名 片源_2.mp4' }))).toBe('输出撞名，改名 片源_2.mp4')
  })

  it('VC-055 进度按 out_time 折算，封顶 99.5，看到 end 才算完', () => {
    const j = job()
    feedProgress(j, 'out_time=00:00:50.000000')
    expect(j.pct).toBe(50)
    feedProgress(j, 'speed=3.20x')
    expect(j.speed).toBe('3.20x')
    feedProgress(j, 'out_time=00:05:00.000000')
    expect(j.pct).toBe(99.5)
    feedProgress(j, 'frame=123')
    expect(j.pct).toBe(99.5)
    feedProgress(j, 'progress=end')
    expect(j.pct).toBe(100)
    // 零时刻不改百分比
    j.pct = 7
    feedProgress(j, 'out_time=00:00:00.000000')
    expect(j.pct).toBe(7)
  })
})

describe('提交与批量', () => {
  it('VC-056 还没打开视频就提交，说的是这一句', () => {
    const s = createState()
    const { spec, error } = fromState(s, new JobQueue(), {})
    expect(spec).toBeNull()
    expect(error).toBe('还没打开视频。')
  })

  it('VC-057 字幕还没抽出来就提交，说稍一下再提交', () => {
    const s = opened()
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    const { spec, error } = fromState(s, new JobQueue(), {})
    expect(spec).toBeNull()
    expect(error).toBe('字幕还没抽出来，稍一下再提交。')
  })

  it('VC-058 提交后的输出名撞了队列里的名字，改名与说明都写在任务上', () => {
    const q = new JobQueue()
    const s = opened()
    s.out.path = 'T:/media/同名.mp4'
    const first = fromState(s, q, {})
    q.enqueue(first.spec!)
    const second = fromState(s, q, {})
    expect(second.spec!.outPath).toBe('T:/media/同名_2.mp4')
    expect(second.spec!.note).toBe('输出和队列里已有的撞名，改名 同名_2.mp4')
    // 参数最后一位跟着换成新名字
    expect(second.spec!.args[second.spec!.args.length - 1]).toBe('T:/media/同名_2.mp4')
  })

  it('VC-059 批量：视频与音频按目标文件重选，配不上的字幕写进说明', () => {
    const cfg = opened()
    cfg.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '简体中文' })
    cfg.probe = probe([
      st(0, 0, 'video', 'hevc', { w: 3840, h: 2160 }),
      st(1, 0, 'audio', 'aac', { lang: 'chi', isDefault: true }),
      st(3, 0, 'subtitle', 'subrip', { lang: 'chi', title: '简体中文' })
    ])
    const target = probe([
      st(0, 0, 'video', 'h264', { w: 1920, h: 1080 }),
      st(1, 0, 'audio', 'aac', { lang: 'eng' }),
      st(2, 1, 'video', 'mjpeg', { attachedPic: true, w: 200, h: 200 })
    ])
    const { state, notes } = forTarget(cfg, target, new JobQueue())
    expect(state.keep.videoRel).toBe(0)
    expect(state.keep.audioRels).toEqual([0])
    expect(state.keep.subs).toEqual([])
    expect(notes).toContain('没找到「简体中文」对应的字幕轨，这个文件不带字幕')
  })

  it('VC-060 批量时目标文件连正片视频都没有，说明里写这一句', () => {
    const cfg = opened()
    const target = probe([st(1, 0, 'audio', 'aac', { lang: 'chi' })])
    const { state, notes } = forTarget(cfg, target, new JobQueue())
    expect(state.keep.videoRel).toBeNull()
    expect(notes).toContain('没有正片视频流')
  })

  it('VC-061 撞名的输出排到 _3，没人占着的名不改', () => {
    expect(uniquePath('T:/a.mp4', ['T:/a.mp4', 'T:/A_2.mp4'])).toBe('T:/a_3.mp4')
    expect(uniquePath('T:/b.mp4', ['T:/a.mp4'])).toBe('T:/b.mp4')
  })
})
