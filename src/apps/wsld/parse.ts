/**
 * wslc 输出的读法。
 *
 * 这里只管"外面那层文本怎么变成数据"：NDJSON 的四种排版、日志行的整理、
 * 错误文案的清洗、`<none>` 这类占位值。字段含义与实测形态见原版项目
 * （wslc 3.0.1）留下的样本，用例直接读那些样本而不是手写 JSON。
 */

/* ---------------- 基础取值 ---------------- */

/**
 * wslc 把数字写成字符串（`"Containers":"2"`），也可能真写成数字或布尔。
 * 一律按字符串读回来：读不出来就是空串，界面再按"没有值"处理，不在这层抛错。
 */
export function loose(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/* ---------------- 列表解析 ---------------- */

export interface RawContainer {
  id: string
  names: string
  image: string
  command: string
  status: string
  state: string
  runningFor: string
  createdAt: string
  ports: string
  networks: string
  labels: string
  size: string
  health: string
  platformOs: string
  platformArch: string
}

export interface RawImage {
  id: string
  repository: string
  tag: string
  size: string
  createdAt: string
  createdSince: string
  containers: string
  digest: string
}

/** 原文片段留这么长：够认出是哪一行，又不至于把错误条撑爆 */
const SNIPPET_CHARS = 120

function readRecords(text: string, kindLabel: string): Record<string, unknown>[] {
  const whole = text.replace(/^\uFEFF/, '').trim()
  if (whole.length === 0) return []

  const first = whole[0]
  if (first === '[' || first === '{') {
    let parsed: unknown
    try {
      parsed = JSON.parse(whole)
    } catch {
      parsed = undefined // 整块不是合法 JSON，退回逐行
    }
    if (parsed !== undefined) {
      if (Array.isArray(parsed)) {
        return parsed.map((item, index) => {
          if (!isRecord(item)) throw badLine(index + 1, kindLabel, '数组里这一项不是对象', String(item), '项')
          return item
        })
      }
      if (isRecord(parsed)) return [parsed]
      throw badLine(1, kindLabel, '不是对象', whole.slice(0, SNIPPET_CHARS), '项')
    }
  }

  // NDJSON：每行一个对象，坏行说清是第几行
  const lines = whole.split('\n')
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw badLine(i + 1, kindLabel, err instanceof Error ? err.message : String(err), line)
    }
    if (!isRecord(parsed)) throw badLine(i + 1, kindLabel, '这一行不是对象', line)
    out.push(parsed)
  }
  return out
}

function badLine(
  lineNumber: number,
  kindLabel: string,
  reason: string,
  line: string,
  unit: '行' | '项' = '行'
): Error {
  const snippet = line.length > SNIPPET_CHARS ? `${line.slice(0, SNIPPET_CHARS)}…` : line
  return new Error(`wslc 输出第 ${lineNumber} ${unit}不是有效的${kindLabel} JSON：${reason}（原文片段：${snippet}）`)
}

export function parseContainers(text: string): RawContainer[] {
  return readRecords(text, '容器').map((row) => {
    const platform = isRecord(row['Platform']) ? row['Platform'] : {}
    return {
      id: loose(row['ID'] ?? row['Id']),
      names: loose(row['Names']),
      image: loose(row['Image']),
      command: loose(row['Command']),
      status: loose(row['Status']),
      state: loose(row['State']),
      runningFor: loose(row['RunningFor']),
      createdAt: loose(row['CreatedAt']),
      ports: loose(row['Ports']),
      networks: loose(row['Networks']),
      labels: loose(row['Labels']),
      size: loose(row['Size']),
      health: loose(row['HealthStatus']),
      platformOs: loose(platform['os'] ?? platform['OS']),
      platformArch: loose(platform['architecture'] ?? platform['Architecture'])
    }
  })
}

export function parseImages(text: string): RawImage[] {
  return readRecords(text, '镜像').map((row) => ({
    id: loose(row['ID'] ?? row['Id']),
    repository: loose(row['Repository']),
    tag: loose(row['Tag']),
    size: loose(row['Size']),
    createdAt: loose(row['CreatedAt']),
    createdSince: loose(row['CreatedSince']),
    containers: loose(row['Containers']),
    digest: loose(row['Digest'])
  }))
}

/* ---------------- 容器标签 ---------------- */

export interface LabelEntry {
  key: string
  value: string
}

/**
 * wslc 把标签拼成一整条逗号分隔的串，而值自己就可能带逗号（那串 JSON 元数据就是）。
 * 所以只在"逗号 + 后面紧跟像键名的东西 + ="处切刀，并跳过引号与花/方括号内部。
 * 这条串本身有歧义：宁可多拆一条，也不丢内容。
 */
export function parseLabels(raw: string): LabelEntry[] {
  if (raw.trim().length === 0) return []
  const cuts: number[] = []
  let depth = 0
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (inQuotes) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inQuotes = false
      continue
    }
    if (c === '"') inQuotes = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth = Math.max(0, depth - 1)
    else if (c === ',' && depth === 0 && looksLikeNextLabel(raw, i + 1)) cuts.push(i)
  }

  const out: LabelEntry[] = []
  let from = 0
  for (const cut of cuts) {
    pushLabel(out, raw.slice(from, cut))
    from = cut + 1
  }
  pushLabel(out, raw.slice(from))
  return out
}

function looksLikeNextLabel(text: string, at: number): boolean {
  let i = at
  while (i < text.length && text[i] === ' ') i++
  const start = i
  while (i < text.length && isKeyChar(text[i]!)) i++
  return i > start && i < text.length && text[i] === '='
}

/** 标签名的字符集：字母数字加 `.-_/:`（前两个是 docker 惯例，冒号与斜杠来自仓库前缀） */
const KEY_CHARS = '.-_:/'

function isKeyChar(c: string): boolean {
  return /[0-9A-Za-z]/.test(c) || KEY_CHARS.includes(c)
}

function pushLabel(out: LabelEntry[], segment: string): void {
  const text = segment.trim()
  if (text.length === 0) return
  const eq = text.indexOf('=')
  if (eq < 0) out.push({ key: '', value: text })
  else out.push({ key: text.slice(0, eq).trim(), value: text.slice(eq + 1).trim() })
}

/* ---------------- 日志行 ---------------- */

/** 单行最多显示这么多字符：一条异常长的日志不该把界面钉死 */
export const MAX_LINE_CHARS = 4000

export const TRUNCATED_SUFFIX = '…（本行过长，已截断显示）'

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s/

/**
 * 原始输出 → 行数组。空文本给空表；末尾那个由换行符产生的空尾巴不算一行，
 * 中间的空行原样保留——那确实是日志的一部分。
 */
export function splitLogLines(raw: string | null | undefined): string[] {
  if (!raw) return []
  const pieces = raw.replace(/\r\n/g, '\n').split('\n')
  const lines = pieces.map((piece) => (piece.endsWith('\r') ? piece.slice(0, -1) : piece))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** 单行整理：只有本次请求带了 -t 才动行首，认不出来就原样站着 */
export function prettyLine(line: string, timestamps: boolean): string {
  const text = timestamps ? replaceTimestampPrefix(line) : line
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}${TRUNCATED_SUFFIX}` : text
}

export function prepareLogLines(raw: string, timestamps: boolean): string[] {
  return splitLogLines(raw).map((line) => prettyLine(line, timestamps))
}

function replaceTimestampPrefix(line: string): string {
  const hit = TIMESTAMP_RE.exec(line)
  if (!hit) return line
  const stamp = hit[1]!
  const at = Date.parse(stamp)
  if (Number.isNaN(at)) return line
  return `${clockOf(new Date(at))}${line.slice(stamp.length)}`
}

/** 本地 时:分:秒.毫秒 */
export function clockOf(date: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/* ---------------- 错误文案 ---------------- */

/** wslc 挂在每个错误后面的那句样板话，对使用者没有价值 */
const BOILERPLATE = '如果此错误是意外错误'

export const WSLC_FAILED = 'wslc 命令执行失败。'

/** stderr → 错误条上那一句：丢掉样板话、丢掉空行，其余连成一句 */
export function cleanWslcError(stderr: string | null | undefined): string {
  if (!stderr || stderr.trim().length === 0) return WSLC_FAILED
  const kept = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes(BOILERPLATE))
  return kept.length === 0 ? WSLC_FAILED : kept.join(' ')
}

/** 手上只有异常时的那一句 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  return cleanWslcError(String(err ?? ''))
}

/* ---------------- 删除冲突与拉取结果 ---------------- */
/**
 * 只有"镜像正被容器使用"这一类失败才允许把按钮升级成强制删除；
 * 其它失败（找不到镜像等）绝不给出这个破坏性选项。
 */
const CONFLICT_MARKERS = ['must force', 'unable to remove repository reference', 'ERROR_SHARING_VIOLATION']

export function isRemovalConflict(text: string | null | undefined): boolean {
  if (!text) return false
  const lower = text.toLowerCase()
  return CONFLICT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()))
}

/** `wslc pull` 的详细输出末尾挂着 Status: 一行，它能区分"真下载了"和"本来就最新" */
export function pullIsUpToDate(stdout: string | null | undefined): boolean {
  if (!stdout) return false
  let status = ''
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line.toLowerCase().startsWith('status:')) status = line.slice('status:'.length).trim()
  }
  return status.toLowerCase().includes('up to date')
}
