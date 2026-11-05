import type { ProbeInfo, StreamInfo } from './state'

/**
 * 探测：本机没有 ffprobe，全部信息从 `ffmpeg -hide_banner -i <file>` 的 stderr 解析。
 * 正则与缩进规则逐条对应 Avalonia 版 Services/Ffmpeg.cs。
 */

const STREAM_RE =
  /^(\s*)Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?:\s*(Video|Audio|Subtitle|Data):\s*([^,\n]*)/
const META_RE = /^\s*(title|language)\s*:\s*(.+?)\s*$/i

export function parseStreams(text: string): StreamInfo[] {
  const list: StreamInfo[] = []
  const rel: Record<string, number> = { video: 0, audio: 0, subtitle: 0, data: 0 }

  let type: string | null = null
  let idx = 0
  let r = 0
  let w = 0
  let h = 0
  let ch = 0
  let sr = 0
  let bitrate = 0
  let fps = 0
  let lang = ''
  let codec = ''
  let title = ''
  let metaLang = ''
  let def = false
  let forced = false
  let pic = false
  let streamIndent = 0

  const flush = (): void => {
    if (type === null) return
    list.push({
      index: idx,
      rel: r,
      type,
      lang: lang.length > 0 ? lang : metaLang,
      codec,
      w,
      h,
      fps,
      channels: ch,
      sampleRate: sr,
      bitrate,
      isDefault: def,
      forced,
      attachedPic: pic,
      title
    })
    type = null
  }

  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const m = STREAM_RE.exec(raw)
    if (m) {
      flush()
      streamIndent = m[1]!.length
      type = m[4]!.toLowerCase()
      r = rel[type] ?? 0
      rel[type] = r + 1
      idx = Number.parseInt(m[2]!, 10)
      lang = m[3] ?? ''
      codec = m[5]!.split(' ')[0] ?? ''
      title = ''
      metaLang = ''
      w = h = ch = sr = bitrate = 0
      fps = 0
      const line = raw.trim()
      def = line.includes('(default)')
      forced = line.includes('(forced)')
      pic = line.includes('(attached pic)')
      if (type === 'video') {
        const res = /(\d{2,5})x(\d{3,5})/.exec(line)
        if (res) {
          w = Number.parseInt(res[1]!, 10)
          h = Number.parseInt(res[2]!, 10)
        }
        const f = /([\d.]+)\s*fps/.exec(line)
        if (f) fps = Number.parseFloat(f[1]!)
      } else if (type === 'audio') {
        const f = /(\d+)\s*Hz/.exec(line)
        if (f) sr = Number.parseInt(f[1]!, 10)
        const c = /(\d+)\s*channels/.exec(line)
        if (c) ch = Number.parseInt(c[1]!, 10)
        else if (/\bmono\b/.test(line)) ch = 1
        else if (/\bstereo\b/.test(line)) ch = 2
      }
      const b = /,\s*(\d+)\s*kb\/s/.exec(line)
      if (b) bitrate = Number.parseInt(b[1]!, 10)
      continue
    }

    if (type === null) continue
    const trimmed = raw.trim()
    if (trimmed.length === 0) continue
    const indent = raw.length - raw.trimStart().length
    // 缩进回到流的层级：上一条流的 metadata 结束
    if (indent <= streamIndent) {
      flush()
      continue
    }
    const mt = META_RE.exec(raw)
    if (!mt) continue
    const key = mt[1]!.toLowerCase()
    const val = mt[2]!
    if (key === 'title' && title.length === 0) title = val
    else if (key === 'language') metaLang = val
  }
  flush()
  return list
}

export interface ProbeFileMeta {
  path: string
  name: string
  dir: string
  size: number
}

export function parseProbe(stderr: string, file: ProbeFileMeta): ProbeInfo {
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const br = /bitrate:\s*(\d+)\s*kb\/s/.exec(stderr)
  const fmt = /Input #0,\s*([^,]+)/.exec(stderr)

  const duration = dur
    ? Number.parseInt(dur[1]!, 10) * 3600 +
      Number.parseInt(dur[2]!, 10) * 60 +
      Number.parseFloat(dur[3]!)
    : 0

  return {
    path: file.path.replace(/\\/g, '/'),
    name: file.name,
    dir: file.dir.replace(/\\/g, '/'),
    size: file.size,
    duration,
    durationText: dur ? `${dur[1]}:${dur[2]}:${dur[3]}` : '',
    bitrate: br ? Number.parseInt(br[1]!, 10) : 0,
    format: fmt ? fmt[1]!.trim() : '',
    streams: parseStreams(stderr)
  }
}

/* ---------- 字幕预览（认轨用） ---------- */

const CUE_TAG_RE = /\{[^}]*\}|<[^>]*>/g

function clean(s: string): string {
  return s
    .replace(/\\N/g, ' ')
    .replace(/\\n/g, ' ')
    .replace(CUE_TAG_RE, '')
    .trim()
}

/** 从 srt / ass / vtt 文本里取开头两句：既没 title 也没语言标记的字幕轨，只能靠内容认出是谁 */
export function subSnippet(raw: string, wantCues = 2): string {
  const cues: string[] = []

  if (/Dialogue:/i.test(raw)) {
    for (const l of raw.split('\n')) {
      const t = l.trim()
      if (!/^Dialogue:/i.test(t)) continue
      const i = t.lastIndexOf(',,')
      const text = clean(i >= 0 ? t.slice(i + 2) : t)
      if (text.length > 0) cues.push(text)
      if (cues.length >= wantCues) break
    }
  } else {
    let cur = ''
    for (const l of `${raw}\n\n`.split('\n')) {
      const t = l.trim()
      if (
        t.length === 0 ||
        /^\d+$/.test(t) ||
        t.includes('-->') ||
        t.startsWith('WEBVTT') ||
        t.startsWith('NOTE') ||
        t.startsWith('Kind:') ||
        t.startsWith('Language:')
      ) {
        if (cur.length > 0) {
          cues.push(cur)
          cur = ''
          if (cues.length >= wantCues) break
        }
        continue
      }
      const cleaned = clean(t)
      cur = cur.length === 0 ? cleaned : `${cur} ${cleaned}`
    }
  }
  return cues.filter((c) => c.length > 0).join(' ／ ')
}

/** 国内下的 srt 常是 GBK：先按 UTF-8 严格解，解不动退 GBK，再不行按 UTF-8 容错解 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes)
    } catch {
      return new TextDecoder('utf-8').decode(bytes)
    }
  }
}
