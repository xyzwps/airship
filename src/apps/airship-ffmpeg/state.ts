/**
 * vcp 状态模型，逐字段对应 Avalonia 版 Logic/State.cs。
 * 命名保持原样（Rel/SubMode/Faststart…），方便和 84 条 selftest 对照。
 */

export interface StreamInfo {
  index: number
  /** 同类型内的相对序号，命令里的 0:v:0 / 0:a:1 用它 */
  rel: number
  type: 'video' | 'audio' | 'subtitle' | 'data' | string
  lang: string
  codec: string
  w: number
  h: number
  fps: number
  channels: number
  sampleRate: number
  bitrate: number
  isDefault: boolean
  forced: boolean
  attachedPic: boolean
  title: string
}

const TEXT_SUB_CODECS = new Set([
  'subrip',
  'ass',
  'ssa',
  'webvtt',
  'text',
  'mov_text',
  'subviewer',
  'subviewer1',
  'microdvd'
])

/** 位图字幕：ffmpeg 只能「文字→文字」「位图→位图」，这类轨只能 copy，转不了也烧不了 */
export function isBitmapSub(s: StreamInfo): boolean {
  return s.type === 'subtitle' && !TEXT_SUB_CODECS.has(s.codec.toLowerCase())
}

/** mkv 里的封面图会被报成一条 video 流，不是正片 */
export function isCover(s: StreamInfo): boolean {
  return s.type === 'video' && s.attachedPic
}

export interface ProbeInfo {
  path: string
  name: string
  dir: string
  size: number
  duration: number
  durationText: string
  bitrate: number
  format: string
  streams: StreamInfo[]
}

export interface SubRef {
  embedded: boolean
  /** 内嵌字幕的相对序号 */
  rel: number
  /** 外部字幕的编号 */
  extId: number
  path: string
  /** 轨道自己带的名字：title 标签 / 语言 / 文件名 */
  name: string
}

export function subKey(s: SubRef): string {
  return s.embedded ? `s${s.rel}` : `e${s.extId}`
}

/** 界面上认人用的名字：轨道 title → 语言 → 文件名 → 未命名 */
export function subTitle(s: SubRef): string {
  if (s.name.length > 0) return s.name
  if (!s.embedded && s.path.length > 0) return s.path.split(/[\\/]/).pop() ?? s.path
  return '未命名'
}

/** 命令里对应的写法，用来和底部那行 ffmpeg 参数对照 */
export function subMap(s: SubRef): string {
  return s.embedded ? `s:${s.rel}` : `in:${s.extId}`
}

/** 缩放只有两档可挑 */
export type ScaleLevel = 1080 | 2160

/** 一键修正里 0 表示"关掉缩放" */
export type ScaleChoice = 0 | ScaleLevel

export interface ScaleProc {
  on: boolean
  p: ScaleLevel
}
export interface FpsProc {
  on: boolean
  v: number
}
export interface TrimProc {
  on: boolean
  ss: string
  to: string
  fast: boolean
}
export interface EqProc {
  on: boolean
  b: number
  c: number
  s: number
}
export interface VolProc {
  on: boolean
  v: number
}
export interface LoudProc {
  on: boolean
}
export interface TextProc {
  on: boolean
  t: string
  size: number
  pos: string
}
export interface PadProc {
  on: boolean
  w: number
  h: number
}

export interface KeepState {
  videoRel: number | null
  audioRels: number[]
  subs: SubRef[]
  /** soft | burn */
  subMode: 'soft' | 'burn'
}

export interface OutState {
  container: string
  vcodec: string
  crf: string
  preset: string
  acodec: string
  abitrate: string
  extra: string
  path: string
  faststart: boolean
  pixFmt: boolean
  pathTouched: boolean
}

export interface AppState {
  probe: ProbeInfo | null
  extSubs: SubRef[]
  /** 内嵌字幕抽取后的临时文件 */
  extracted: Record<string, string>
  keep: KeepState
  out: OutState
  scale: ScaleProc
  fps: FpsProc
  trim: TrimProc
  eq: EqProc
  vol: VolProc
  loud: LoudProc
  text: TextProc
  pad: PadProc
}

export function createState(): AppState {
  return {
    probe: null,
    extSubs: [],
    extracted: {},
    keep: { videoRel: null, audioRels: [], subs: [], subMode: 'soft' },
    out: {
      container: 'mp4',
      vcodec: 'libx264',
      crf: '20',
      preset: 'medium',
      acodec: 'aac',
      abitrate: '192k',
      extra: '',
      path: '',
      faststart: true,
      pixFmt: true,
      pathTouched: false
    },
    scale: { on: false, p: 1080 },
    fps: { on: false, v: 30 },
    trim: { on: false, ss: '', to: '', fast: true },
    eq: { on: false, b: 0, c: 1, s: 1 },
    vol: { on: false, v: 1.5 },
    loud: { on: false },
    text: { on: false, t: '水印', size: 32, pos: '右下' },
    pad: { on: false, w: 1080, h: 1920 }
  }
}

export function mainVideo(s: AppState): StreamInfo | null {
  if (!s.probe || s.keep.videoRel === null) return null
  return s.probe.streams.find((x) => x.type === 'video' && x.rel === s.keep.videoRel) ?? null
}

export function anyVideoFilter(s: AppState): boolean {
  return (
    s.scale.on ||
    s.pad.on ||
    s.eq.on ||
    s.text.on ||
    s.fps.on ||
    (s.keep.subs.length > 0 && s.keep.subMode === 'burn')
  )
}

/** 批量提交用：换一份 Probe、重选流，处理与输出参数照抄 */
export function cloneState(s: AppState): AppState {
  return {
    ...s,
    probe: s.probe,
    extSubs: [...s.extSubs],
    extracted: { ...s.extracted },
    keep: {
      videoRel: s.keep.videoRel,
      audioRels: [...s.keep.audioRels],
      subs: [...s.keep.subs],
      subMode: s.keep.subMode
    },
    out: { ...s.out },
    scale: { ...s.scale },
    fps: { ...s.fps },
    trim: { ...s.trim },
    eq: { ...s.eq },
    vol: { ...s.vol },
    loud: { ...s.loud },
    text: { ...s.text },
    pad: { ...s.pad }
  }
}

/** 字节数转人话 */
export function human(bytes: number): string {
  if (bytes > 1 << 30) return `${(bytes / 1073741824).toFixed(2)} GB`
  if (bytes > 1 << 20) return `${(bytes / 1048576).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}
