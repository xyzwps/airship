import {
  isBitmapSub,
  mainVideo,
  subKey,
  type AppState,
  type SubRef
} from './state'

/**
 * ffmpeg 命令构建，逐条对应 Avalonia 版 Logic/CommandBuilder.cs。
 * 纯函数（checks 例外，它需要输出文件的存在性，由调用方查好传进来），
 * 所以能直接拿原版的 84 条 selftest 当单测跑。
 */

const NEEDS_QUOTE = /[\s"'`$]/

/** 滤镜图里的路径：正斜杠 + 转义冒号 + 单引号包住 */
export function fpath(p: string): string {
  return `'${p.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
}

export function burnSubs(s: AppState): SubRef[] {
  return s.keep.subMode === 'burn' ? s.keep.subs : []
}

function n(v: number): string {
  return String(v)
}

function posXY(p: string): string {
  switch (p) {
    case '右下':
      return 'x=w-tw-24:y=h-th-24'
    case '左下':
      return 'x=24:y=h-th-24'
    case '右上':
      return 'x=w-tw-24:y=24'
    default:
      return 'x=24:y=24'
  }
}

export function videoFilters(s: AppState): string[] {
  const f: string[] = []
  if (s.scale.on && s.scale.w !== 0) f.push(`scale=w=${s.scale.w}:h=${s.scale.h}`)
  if (s.pad.on) f.push(`pad=${s.pad.w}:${s.pad.h}:(ow-iw)/2:(oh-ih)/2:color=black`)
  if (s.eq.on) f.push(`eq=brightness=${n(s.eq.b)}:contrast=${n(s.eq.c)}:saturation=${n(s.eq.s)}`)
  if (s.text.on)
    f.push(
      `drawtext=text='${s.text.t}':fontfile=${fpath('C:/Windows/Fonts/msyh.ttc')}:fontsize=${s.text.size}:fontcolor=white@0.85:${posXY(s.text.pos)}`
    )
  if (s.fps.on && s.fps.v !== 0) f.push(`fps=fps=${s.fps.v}`)
  return f
}

export function audioFilters(s: AppState): string[] {
  const f: string[] = []
  if (s.vol.on) f.push(`volume=${n(s.vol.v)}`)
  if (s.loud.on) f.push('loudnorm=I=-16:TP=-1.5:LDI=11')
  return f
}

function placeholder(sub: SubRef): string {
  return sub.embedded ? `@EXTRACT@${sub.rel}` : sub.path
}

function extInputIndex(s: AppState, sub: SubRef): number {
  return 1 + s.extSubs.findIndex((e) => subKey(e) === subKey(sub))
}

/** extract 传进来时用调用方自己的临时字幕表（任务快照要持有自己的副本），否则用界面上那份 */
export function build(s: AppState, extract?: Record<string, string>): string[] {
  const extracted = extract ?? s.extracted
  const a: string[] = ['-y']
  const o = s.out
  if (!s.probe) return a

  if (s.trim.on && s.trim.ss.length > 0 && s.trim.fast) {
    a.push('-ss', s.trim.ss)
  }
  a.push('-i', s.probe.path)
  for (const e of s.extSubs) a.push('-i', e.path)
  if (s.trim.on && s.trim.ss.length > 0 && !s.trim.fast) a.push('-ss', s.trim.ss)
  if (s.trim.on && s.trim.to.length > 0) a.push('-to', s.trim.to)

  if (s.keep.videoRel !== null) a.push('-map', `0:v:${s.keep.videoRel}`)
  else a.push('-vn')
  for (const i of s.keep.audioRels) a.push('-map', `0:a:${i}`)
  if (s.keep.audioRels.length === 0) a.push('-an')

  if (s.keep.subs.length > 0 && s.keep.subMode === 'soft') {
    for (const sub of s.keep.subs) {
      a.push('-map', sub.embedded ? `0:s:${sub.rel}` : `${extInputIndex(s, sub)}:s:0`)
    }
  }

  const chain = videoFilters(s)
  for (const sub of burnSubs(s)) {
    const file = sub.embedded ? (extracted[subKey(sub)] ?? placeholder(sub)) : sub.path
    chain.push(`subtitles=filename=${fpath(file)}`)
  }
  if (chain.length > 0) a.push('-vf', chain.join(','))

  const af = audioFilters(s)
  if (af.length > 0 && s.keep.audioRels.length > 0) a.push('-af', af.join(','))

  a.push('-c:v', o.vcodec)
  if (o.vcodec !== 'copy') {
    a.push(o.vcodec.endsWith('nvenc') || o.vcodec.endsWith('qsv') ? '-cq' : '-crf')
    a.push(o.crf)
    a.push('-preset', o.preset)
  }
  a.push('-c:a', o.acodec)
  if (o.acodec !== 'copy' && o.abitrate.length > 0) a.push('-b:a', o.abitrate)

  if (s.keep.subs.length > 0 && s.keep.subMode === 'soft') {
    const codecs = s.keep.subs.map((sub) => subCodec(s, sub))
    const distinct = new Set(codecs)
    if (distinct.size === 1) a.push('-c:s', codecs[0]!)
    // 图形轨和文字轨混在一起时，只能逐轨指定编码器
    else codecs.forEach((c, i) => a.push(`-c:s:${i}`, c))
  }

  if (o.pixFmt && s.keep.videoRel !== null && o.vcodec !== 'copy') a.push('-pix_fmt', 'yuv420p')
  if (o.faststart && o.container === 'mp4' && o.vcodec !== 'copy') a.push('-movflags', '+faststart')
  if (o.extra.trim().length > 0) a.push(...o.extra.trim().split(/\s+/))
  a.push(o.path.length > 0 ? o.path : `out.${o.container}`)
  return a
}

/** 内嵌的是位图字幕：转不了 srt/mov_text，也烧不进画面 */
function bitmapSub(s: AppState, sub: SubRef): boolean {
  if (!sub.embedded || !s.probe) return false
  const stream = s.probe.streams.find((x) => x.type === 'subtitle' && x.rel === sub.rel)
  return stream ? isBitmapSub(stream) : false
}

/** 位图字幕只能原样复制；文字字幕按容器转 srt（mkv）或 mov_text（mp4） */
function subCodec(s: AppState, sub: SubRef): string {
  if (bitmapSub(s, sub)) return 'copy'
  return s.out.container === 'mkv' ? 'srt' : 'mov_text'
}

export function display(args: string[]): string {
  return (
    'ffmpeg ' +
    args
      .map((x) => (NEEDS_QUOTE.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x))
      .join(' ')
  )
}

export function defaultOutPath(s: AppState): void {
  if (!s.probe) return
  const stem = s.probe.name.replace(/\.[^.]+$/, '')
  const mv = mainVideo(s)
  const tag = s.scale.on
    ? `_${
        s.scale.h > 0
          ? s.scale.h
          : mv && mv.w > 0
            ? Math.round((s.scale.w * mv.h) / mv.w / 2) * 2
            : 1080
      }p`
    : ''
  s.out.path = `${s.probe.dir}/${stem}${tag}.${s.out.container}`
}

/**
 * 后缀永远跟着容器换，主名一个字不动。
 * ffmpeg 是按输出文件名的后缀认容器的，容器改了而后缀没改，产物就是后缀那一个——名字在说谎。
 * 结尾没有点（或点打头）就当没有后缀，直接补一个；整条以分隔符结尾（那是个目录）原样退回。
 */
export function swapExt(path: string, container: string): string {
  if (path.length === 0) return path
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const dir = slash >= 0 ? path.slice(0, slash + 1) : ''
  const base = slash >= 0 ? path.slice(slash + 1) : path
  if (base.length === 0) return path
  const dot = base.lastIndexOf('.')
  return `${dir}${dot > 0 ? base.slice(0, dot) : base}.${container}`
}

/** 输出名结尾那一段后缀，小写；没有后缀给空串 */
function outExt(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * 每一次界面改动之后收拾输出名，规则只在这里写一遍（界面上的 mut 与一键修正都走它）：
 *   - 用户没亲手动过「输出到」：整条按当前设置重算（缩放那一截、容器后缀都在名字里）
 *   - 手敲过：主名不再被覆盖，但换容器时后缀跟着换
 * containerBefore 是这次改动之前的容器，用来认出"这一次是不是在换容器"。
 */
export function syncOutPath(s: AppState, containerBefore: string): void {
  if (!s.out.pathTouched) defaultOutPath(s)
  else if (s.out.container !== containerBefore) s.out.path = swapExt(s.out.path, s.out.container)
}

/* ---------- 校验 ---------- */

export type Fix =
  | { kind: 'vcodec'; value: string }
  | { kind: 'acodec'; value: string }
  | { kind: 'scale-reset' }
  | { kind: 'container'; value: string }
  | { kind: 'submode-soft' }
  | { kind: 'scale-on' }
  | { kind: 'out-rename' }
  | { kind: 'out-ext' }

export interface Note {
  level: 'error' | 'warn' | 'info'
  msg: string
  fixLabel?: string
  fix?: Fix
}

export interface OutStat {
  size: number
}

export function checks(s: AppState, outStat: OutStat | null): Note[] {
  const v: Note[] = []
  const o = s.out
  if (!s.probe) {
    v.push({ level: 'error', msg: '还没有打开视频。' })
    return v
  }

  const vf = videoFilters(s)
  const burn = burnSubs(s)
  const main = mainVideo(s)

  if (s.keep.videoRel === null && s.keep.audioRels.length === 0)
    v.push({ level: 'error', msg: '一条流都没保留，输出会是空文件。' })

  if (o.vcodec === 'copy' && (vf.length > 0 || burn.length > 0))
    v.push({
      level: 'error',
      msg: `画面要经过 ${vf.length + burn.length} 步处理，视频不能选“直接复制”，否则这些处理全部不生效。`,
      fixLabel: '改用 x264',
      fix: { kind: 'vcodec', value: 'libx264' }
    })

  if (main && s.scale.on && s.scale.w > main.w)
    v.push({
      level: 'warn',
      msg: `目标宽 ${s.scale.w} 大于源宽 ${main.w}，放大只会更糊、更大。`,
      fixLabel: '改回 1920',
      fix: { kind: 'scale-reset' }
    })

  if (main && s.pad.on && (s.pad.w < main.w || s.pad.h < main.h))
    v.push({
      level: 'error',
      msg: `补边画布 ${s.pad.w}×${s.pad.h} 小于源 ${main.w}×${main.h}，ffmpeg 会报 “Padded dimensions cannot be smaller than input dimensions”。`
    })

  if (o.acodec === 'copy' && audioFilters(s).length > 0)
    v.push({
      level: 'error',
      msg: '音量/响度滤镜需要重编码音频，当前音频是直接复制。',
      fixLabel: '改用 aac',
      fix: { kind: 'acodec', value: 'aac' }
    })

  if (s.vol.on && s.loud.on)
    v.push({ level: 'warn', msg: '音量和响度归一同时开，归一会盖过手动倍数。' })

  if (
    s.trim.on &&
    s.trim.to.length > 0 &&
    s.trim.ss.length > 0 &&
    s.trim.to.localeCompare(s.trim.ss) <= 0
  )
    v.push({ level: 'error', msg: '结束时间早于开始时间。' })

  if (s.keep.subs.length > 0 && s.keep.subMode === 'soft' && o.container === 'mp4')
    v.push({
      level: 'info',
      msg: 'mp4 软字幕用 mov_text，部分电视/盒子不认；要稳选 mkv。',
      fixLabel: '换成 mkv',
      fix: { kind: 'container', value: 'mkv' }
    })

  const softBitmap =
    s.keep.subMode === 'soft' ? s.keep.subs.filter((sub) => bitmapSub(s, sub)) : []
  if (softBitmap.length > 0 && o.container !== 'mkv')
    v.push({
      level: 'error',
      msg: `s:${softBitmap.map((b) => b.rel).join('、s:')} 是蓝光图形字幕，mp4 装不下它（mov_text 只收文字字幕），执行会报 “Subtitle encoding currently only possible from text to text or bitmap to bitmap”。`,
      fixLabel: '换成 mkv，图形字幕原样复制',
      fix: { kind: 'container', value: 'mkv' }
    })

  const burnBitmap = burn.filter((sub) => bitmapSub(s, sub))
  if (burnBitmap.length > 0)
    v.push({
      level: 'error',
      msg: '图形字幕烧不进画面：subtitles 滤镜只读文字字幕，抽不成 srt。',
      fixLabel: '改用软字幕',
      fix: { kind: 'submode-soft' }
    })

  if (burn.some((b) => b.embedded && !(subKey(b) in s.extracted)))
    v.push({
      level: 'info',
      msg: '烧入内嵌字幕：选中时会先抽成临时 srt，因为 subtitles 滤镜只读文件不读流。'
    })

  if (o.path.length === 0) v.push({ level: 'error', msg: '没填输出路径。' })
  else if (o.path.replace(/\\/g, '/').toLowerCase() === s.probe.path.toLowerCase())
    v.push({ level: 'error', msg: '输出路径与源文件相同，会毁掉源文件。' })
  else if (outStat)
    v.push({
      level: 'warn',
      msg: `输出文件已存在（${(outStat.size / 1048576).toFixed(1)} MB），执行会直接覆盖。`,
      fixLabel: '另存为新名',
      fix: { kind: 'out-rename' }
    })

  if (o.path.length > 0) {
    const ext = outExt(o.path)
    if (ext !== o.container.toLowerCase())
      v.push({
        level: 'warn',
        msg: ext
          ? `输出名后缀是 .${ext}，容器选的却是 ${o.container}：ffmpeg 按后缀认容器，产物会是 .${ext}。`
          : `输出名没有后缀，而容器选的是 ${o.container}：ffmpeg 按后缀认容器，产物会没有格式。`,
        fixLabel: ext ? `换成 .${o.container}` : `补上 .${o.container}`,
        fix: { kind: 'out-ext' }
      })
  }

  if (main && main.w >= 3840 && !s.scale.on && o.vcodec !== 'copy')
    v.push({
      level: 'info',
      msg: '源是 4K 又没开缩放，CPU 编码会非常慢。',
      fixLabel: '开启缩放',
      fix: { kind: 'scale-on' }
    })

  return v
}
