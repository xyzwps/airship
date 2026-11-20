/**
 * `wslc run` 命令编排的纯函数层（RB 册子的影子）。
 *
 * 四件套全部不碰界面、不碰进程：
 *   - `runArgs` 把表单拼成进程参数数组（拼装顺序恒定，见 wsld-run.md RB-005）；
 *   - `runCommand` 拼成给人复制的那一条（与参数数组同源，不存在"预览一个、执行另一个"）；
 *   - `validateRunSpec` 一次列出全部问题，复制与就地执行共用这条有效性判断；
 *   - `tryParseRun` 把一条现成的 `wslc run` 读回表单，认不出的选项整段进「其他参数」。
 *
 * 分词与转义按 CommandLineToArgvW 语义成对实现（tokenize 是 quote 的逆函数），
 * 保证 显示 → 复制 → 读回 → 再显示 逐字不变（RB-034）。
 * 这些语义的原版实现在 wslc-desktop 的 RunCommandBuilder.cs，实测依据见其 docs/notes/run-command.md。
 */

/* ---------------- 表单形状 ---------------- */

export interface PortRow {
  hostIp: string
  hostPort: string
  containerPort: string
  /** tcp 或 udp；界面只给这两个选项 */
  protocol: string
}

export interface VolumeRow {
  source: string
  target: string
  readOnly: boolean
}

export interface EnvRow {
  key: string
  value: string
}

export interface LabelRow {
  key: string
  value: string
}

export interface PathRow {
  path: string
}

/** 一条正在编排的 wslc run 的完整可编辑状态。字段一律"留空 = 不输出这个选项"（detach 例外：默认勾着） */
export interface RunSpec {
  image: string
  name: string
  detach: boolean
  rm: boolean
  publishAll: boolean
  interactive: boolean
  tty: boolean
  /** 空串 = 不下发 --pull，让 wslc 自己的默认（missing）生效 */
  pullPolicy: string
  entrypoint: string
  command: string
  /** 跟在命令后面的参数，原样一段文本：按空白分词，带空格的片段用引号包住 */
  arguments: string
  hostname: string
  network: string
  cpus: string
  memory: string
  shmSize: string
  workdir: string
  user: string
  envFile: string
  healthCmd: string
  healthInterval: string
  healthTimeout: string
  healthRetries: string
  healthStartPeriod: string
  noHealthcheck: boolean
  /** 原样透传的额外参数（按引号感知的规则分词） */
  extraArgs: string
  ports: PortRow[]
  volumes: VolumeRow[]
  envVars: EnvRow[]
  labels: LabelRow[]
  tmpfsPaths: PathRow[]
}

export const emptyRunSpec = (): RunSpec => ({
  image: '',
  name: '',
  detach: true,
  rm: false,
  publishAll: false,
  interactive: false,
  tty: false,
  pullPolicy: '',
  entrypoint: '',
  command: '',
  arguments: '',
  hostname: '',
  network: '',
  cpus: '',
  memory: '',
  shmSize: '',
  workdir: '',
  user: '',
  envFile: '',
  healthCmd: '',
  healthInterval: '',
  healthTimeout: '',
  healthRetries: '',
  healthStartPeriod: '',
  noHealthcheck: false,
  extraArgs: '',
  ports: [],
  volumes: [],
  envVars: [],
  labels: [],
  tmpfsPaths: []
})

export const newPortRow = (): PortRow => ({ hostIp: '', hostPort: '', containerPort: '', protocol: 'tcp' })
export const newVolumeRow = (): VolumeRow => ({ source: '', target: '', readOnly: false })
export const newEnvRow = (): EnvRow => ({ key: '', value: '' })
export const newLabelRow = (): LabelRow => ({ key: '', value: '' })
export const newPathRow = (): PathRow => ({ path: '' })

/** `--pull` 的三个显式取值；界面上的"默认"= 不在这里 */
export const PULL_POLICIES = ['always', 'missing', 'never'] as const

/* ---------------- 整行留空 ---------------- */

export const portIsEmpty = (row: PortRow): boolean =>
  row.hostIp.trim().length === 0 && row.hostPort.trim().length === 0 && row.containerPort.trim().length === 0

export const volumeIsEmpty = (row: VolumeRow): boolean =>
  row.source.trim().length === 0 && row.target.trim().length === 0

export const envIsEmpty = (row: EnvRow): boolean => row.key.trim().length === 0 && row.value.length === 0

export const labelIsEmpty = (row: LabelRow): boolean => row.key.trim().length === 0 && row.value.length === 0

export const pathIsEmpty = (row: PathRow): boolean => row.path.trim().length === 0

/* ---------------- 拼装 ---------------- */

function addValue(args: string[], flag: string, value: string): void {
  const trimmed = value.trim()
  if (trimmed.length > 0) {
    args.push(flag)
    args.push(trimmed)
  }
}

function buildPortSpec(port: PortRow): string {
  const ip = port.hostIp.trim()
  const host = port.hostPort.trim()
  const container = port.containerPort.trim()
  const protocol = port.protocol.trim().toLowerCase()
  let text = ''
  if (ip.length > 0) text += `${ip}:`
  if (host.length > 0 || ip.length > 0) text += `${host}:`
  text += container
  if (protocol.length > 0 && protocol !== 'tcp') text += `/${protocol}`
  return text
}

const buildVolumeSpec = (volume: VolumeRow): string =>
  `${volume.source.trim()}:${volume.target.trim()}${volume.readOnly ? ':ro' : ''}`

/**
 * 生成交给 `wslc` 的参数数组（首个元素是动词 run）。
 * 顺序恒定：开关 → 值选项 → 变量/标签 → 端口 → 入口 → tmpfs/挂载 → 健康检查 → 其他参数 → 镜像 → 命令 → 参数。
 */
export function runArgs(spec: RunSpec): string[] {
  const args: string[] = ['run']

  if (spec.detach) args.push('-d')
  if (spec.interactive) args.push('-i')
  if (spec.tty) args.push('-t')
  if (spec.rm) args.push('--rm')
  if (spec.publishAll) args.push('-P')

  addValue(args, '--pull', spec.pullPolicy)
  addValue(args, '--name', spec.name)
  addValue(args, '-h', spec.hostname)
  addValue(args, '--network', spec.network)
  addValue(args, '--cpus', spec.cpus)
  addValue(args, '-m', spec.memory)
  addValue(args, '--shm-size', spec.shmSize)
  addValue(args, '-w', spec.workdir)
  addValue(args, '-u', spec.user)

  for (const env of spec.envVars) {
    if (envIsEmpty(env)) continue
    const key = env.key.trim()
    args.push('-e', env.value.length === 0 ? `${key}=` : `${key}=${env.value}`)
  }
  addValue(args, '--env-file', spec.envFile)

  for (const label of spec.labels) {
    if (labelIsEmpty(label)) continue
    args.push('-l', `${label.key.trim()}=${label.value}`)
  }

  for (const port of spec.ports) {
    if (portIsEmpty(port)) continue
    args.push('-p', buildPortSpec(port))
  }

  addValue(args, '--entrypoint', spec.entrypoint)

  for (const tmpfs of spec.tmpfsPaths) {
    if (pathIsEmpty(tmpfs)) continue
    args.push('--tmpfs', tmpfs.path.trim())
  }

  for (const volume of spec.volumes) {
    if (volumeIsEmpty(volume)) continue
    args.push('-v', buildVolumeSpec(volume))
  }

  addValue(args, '--health-cmd', spec.healthCmd)
  addValue(args, '--health-interval', spec.healthInterval)
  addValue(args, '--health-timeout', spec.healthTimeout)
  addValue(args, '--health-retries', spec.healthRetries)
  addValue(args, '--health-start-period', spec.healthStartPeriod)
  if (spec.noHealthcheck) args.push('--no-healthcheck')

  for (const extra of tokenize(spec.extraArgs)) args.push(extra)

  const image = spec.image.trim()
  if (image.length > 0) args.push(image)

  const command = spec.command.trim()
  if (command.length > 0) args.push(command)

  for (const argument of tokenize(spec.arguments)) args.push(argument)
  return args
}

/** 拼成给人复制的一条命令（转义规则让它在 PowerShell 与 cmd 里都站得住） */
export const runCommand = (spec: RunSpec): string =>
  `wslc ${runArgs(spec).map(quote).join(' ')}`

/* ---------------- 校验 ---------------- */

export type RunIssueCode =
  | 'image-missing'
  | 'port-container'
  | 'port-number'
  | 'port-range'
  | 'port-protocol'
  | 'volume-source'
  | 'volume-target'
  | 'tmpfs-path'
  | 'env-key'
  | 'label-key'
  | 'health-retries'
  | 'cpus'

/** Code 决定取哪句文案，Row 是 1 基行号，Value 是回显用的原始输入 */
export interface RunIssue {
  code: RunIssueCode
  row?: number
  value?: string
}

/** 端口可以写单个（1..65535）也可以写范围（start-end，start<=end）；返回跨度供配对检查 */
function portOrRange(text: string): { low: number; high: number } | null {
  if (!text.includes('-')) {
    if (!/^\d+$/.test(text)) return null
    const single = Number.parseInt(text, 10)
    if (single < 1 || single > 65535) return null
    return { low: single, high: single }
  }
  const parts = text.split('-').map((part) => part.trim())
  if (parts.length !== 2) return null
  if (!parts[0] || !parts[1] || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null
  const low = Number.parseInt(parts[0], 10)
  const high = Number.parseInt(parts[1], 10)
  if (low < 1 || high > 65535 || low > high) return null
  return { low, high }
}

const startsContainerPath = (value: string): boolean => {
  const text = value.trim()
  return text.length > 0 && (text[0] === '/' || text[0] === '~')
}

/** 收集所有问题（不只第一个），界面逐行列出；空表 = 可以执行 */
export function validateRunSpec(spec: RunSpec): RunIssue[] {
  const issues: RunIssue[] = []

  if (spec.image.trim().length === 0) issues.push({ code: 'image-missing' })

  spec.ports.forEach((port, index) => {
    if (portIsEmpty(port)) return
    const row = index + 1
    const container = port.containerPort.trim()
    let containerRange: { low: number; high: number } | null = null
    if (container.length === 0) {
      issues.push({ code: 'port-container', row })
    } else {
      containerRange = portOrRange(container)
      if (!containerRange) issues.push({ code: 'port-number', row, value: container })
    }

    const host = port.hostPort.trim()
    if (host.length > 0) {
      const hostRange = portOrRange(host)
      if (!hostRange) {
        issues.push({ code: 'port-number', row, value: host })
      } else if (containerRange && hostRange.high - hostRange.low !== containerRange.high - containerRange.low) {
        // 一端写范围另一端写单端口（或长度不同的两个范围），wslc 会直接拒
        issues.push({ code: 'port-range', row })
      }
    }

    const protocol = port.protocol.trim()
    if (protocol.length > 0 && protocol.toLowerCase() !== 'tcp' && protocol.toLowerCase() !== 'udp') {
      issues.push({ code: 'port-protocol', row })
    }
  })

  spec.volumes.forEach((volume, index) => {
    if (volumeIsEmpty(volume)) return
    const row = index + 1
    if (volume.source.trim().length === 0) issues.push({ code: 'volume-source', row })
    if (!startsContainerPath(volume.target)) issues.push({ code: 'volume-target', row })
  })

  spec.tmpfsPaths.forEach((tmpfs, index) => {
    if (pathIsEmpty(tmpfs)) return
    if (!startsContainerPath(tmpfs.path)) issues.push({ code: 'tmpfs-path', row: index + 1 })
  })

  spec.envVars.forEach((env, index) => {
    if (envIsEmpty(env)) return
    const key = env.key.trim()
    if (key.length === 0 || key.includes('=')) issues.push({ code: 'env-key', row: index + 1 })
  })

  spec.labels.forEach((label, index) => {
    if (labelIsEmpty(label)) return
    const key = label.key.trim()
    if (key.length === 0 || key.includes('=')) issues.push({ code: 'label-key', row: index + 1 })
  })

  if (spec.healthRetries.trim().length > 0 && !/^\d+$/.test(spec.healthRetries.trim())) {
    issues.push({ code: 'health-retries' })
  }

  if (spec.cpus.trim().length > 0) {
    const value = Number(spec.cpus.trim())
    if (!/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(spec.cpus.trim()) || !Number.isFinite(value) || value <= 0) {
      issues.push({ code: 'cpus' })
    }
  }

  return issues
}

/** 问题码 → 界面上那一句人话（带行号与回显原值） */
export function describeRunIssue(issue: RunIssue): string {
  const row = String(issue.row ?? 0)
  switch (issue.code) {
    case 'image-missing':
      return '镜像不能为空 —— 至少要指定一个镜像。'
    case 'port-container':
      return `端口第 ${row} 行：容器端口不能为空。`
    case 'port-number':
      return `端口第 ${row} 行：${issue.value ?? ''} 不像端口（可用 8080 或 8000-8010）。`
    case 'port-range':
      return `端口第 ${row} 行：两端要么都写单个端口，要么都写同样长度的范围。`
    case 'port-protocol':
      return `端口第 ${row} 行：协议只能是 tcp 或 udp。`
    case 'volume-source':
      return `挂载第 ${row} 行：缺少来源（主机路径或卷名）。`
    case 'volume-target':
      return `挂载第 ${row} 行：容器内路径必须以 / 开头。`
    case 'tmpfs-path':
      return `tmpfs 第 ${row} 行：路径必须以 / 开头。`
    case 'env-key':
      return `环境变量第 ${row} 行：变量名不能为空，也不能带 = 号。`
    case 'label-key':
      return `标签第 ${row} 行：键名不能为空，也不能带 = 号。`
    case 'health-retries':
      return '健康检查的重试次数需要是整数。'
    case 'cpus':
      return 'CPU 数需要是数字，例如 0.5、1、2.5。'
  }
}

/* ---------------- 反向解析（读回一条现成命令） ---------------- */

/**
 * `wslc run` 的"带值"选项全集（对照 wslc run --help 实测抄全，含长短形式）。
 * 未知选项只透传标志本身，不会误吞后面的镜像名；表单没有对应控件的整对进「其他参数」。
 */
const VALUE_FLAGS = new Set([
  '--cidfile', '--cpus', '--dns', '--dns-option', '--dns-search', '--domainname',
  '--entrypoint', '-e', '--env', '--env-file', '--gpus',
  '--health-cmd', '--health-interval', '--health-retries', '--health-start-period', '--health-timeout',
  '-h', '--hostname', '--ip', '-l', '--label', '-m', '--memory',
  '--mount', '--name', '--network', '--network-alias',
  '-p', '--publish', '--pull', '--shm-size', '--stop-signal', '--stop-timeout',
  '--tmpfs', '--ulimit', '-u', '--user', '-v', '--volume', '-w', '--workdir'
])

/** 读回一条 `wslc run ...`（认 wslc / wslc.exe / 绝对路径 / `wslc container run` 四种前缀）；读不懂给 null */
export function tryParseRun(commandLine: string): RunSpec | null {
  if (commandLine.trim().length === 0) return null

  const tokens = tokenize(commandLine)
  let start = 0

  if (tokens.length > 0 && isWslcToken(tokens[0]!)) start = 1
  if (start >= tokens.length) return null

  if (
    tokens[start]?.toLowerCase() === 'container' &&
    tokens[start + 1]?.toLowerCase() === 'run'
  ) {
    start += 2
  } else if (tokens[start]?.toLowerCase() === 'run') {
    start += 1
  } else {
    return null
  }

  const result = emptyRunSpec()
  result.detach = false
  const positionals: string[] = []

  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!

    // 位置参数开始后，后面的一切都归位置参数（镜像 / 命令 / 容器参数）：
    // 这是 docker 类 CLI 的通用约定，选项必须写在镜像之前
    if (positionals.length > 0 || !token.startsWith('-') || token === '-') {
      positionals.push(token)
      continue
    }

    const takeValue = (): string | null => (i + 1 < tokens.length ? tokens[++i]! : null)

    switch (token) {
      case '-d':
      case '--detach':
        result.detach = true
        break
      case '-i':
      case '--interactive':
        result.interactive = true
        break
      case '-t':
      case '--tty':
        result.tty = true
        break
      case '--rm':
        result.rm = true
        break
      case '-P':
      case '--publish-all':
        result.publishAll = true
        break
      case '--no-healthcheck':
        result.noHealthcheck = true
        break

      case '--pull': {
        // 认得的三种策略落回下拉框；认不得的（--pull if-not-present 这类）整对透传到「其他参数」，
        // 否则下拉框显示"默认"而命令里跑的是别的，预览和执行就不一致了
        const pull = takeValue()
        if (pull === null) break
        if ((PULL_POLICIES as readonly string[]).includes(pull)) result.pullPolicy = pull
        else result.extraArgs = joinQuoted(result.extraArgs, token, pull)
        break
      }
      case '--name':
        result.name = takeValue() ?? ''; break
      case '-h':
      case '--hostname':
        result.hostname = takeValue() ?? ''; break
      case '--network':
        result.network = takeValue() ?? ''; break
      case '--cpus':
        result.cpus = takeValue() ?? ''; break
      case '-m':
      case '--memory':
        result.memory = takeValue() ?? ''; break
      case '--shm-size':
        result.shmSize = takeValue() ?? ''; break
      case '-w':
      case '--workdir':
        result.workdir = takeValue() ?? ''; break
      case '-u':
      case '--user':
        result.user = takeValue() ?? ''; break
      case '--env-file':
        result.envFile = takeValue() ?? ''; break
      case '--entrypoint':
        result.entrypoint = takeValue() ?? ''; break
      case '--health-cmd':
        result.healthCmd = takeValue() ?? ''; break
      case '--health-interval':
        result.healthInterval = takeValue() ?? ''; break
      case '--health-timeout':
        result.healthTimeout = takeValue() ?? ''; break
      case '--health-retries':
        result.healthRetries = takeValue() ?? ''; break
      case '--health-start-period':
        result.healthStartPeriod = takeValue() ?? ''; break

      case '-e':
      case '--env': {
        const env = takeValue()
        if (env !== null) {
          const eq = env.indexOf('=')
          result.envVars.push(
            eq < 0 ? { key: env, value: '' } : { key: env.slice(0, eq), value: env.slice(eq + 1) }
          )
        }
        break
      }
      case '-l':
      case '--label': {
        const label = takeValue()
        if (label !== null) {
          const eq = label.indexOf('=')
          result.labels.push(
            eq < 0 ? { key: label, value: '' } : { key: label.slice(0, eq), value: label.slice(eq + 1) }
          )
        }
        break
      }
      case '-p':
      case '--publish': {
        const port = takeValue()
        if (port !== null) result.ports.push(parsePortSpec(port))
        break
      }
      case '-v':
      case '--volume': {
        const volume = takeValue()
        if (volume !== null) result.volumes.push(parseVolumeSpec(volume))
        break
      }
      case '--tmpfs': {
        const path = takeValue()
        if (path !== null) result.tmpfsPaths.push({ path })
        break
      }

      default:
        if (VALUE_FLAGS.has(token) && i + 1 < tokens.length) {
          // 已知带值但表单没有对应控件（--gpus/--dns/--ulimit…）：整对透传到「其他参数」
          result.extraArgs = joinQuoted(result.extraArgs, token, tokens[++i]!)
        } else {
          result.extraArgs = joinQuoted(result.extraArgs, token)
        }
        break
    }
  }

  if (positionals.length > 0) result.image = positionals[0]!
  if (positionals.length > 1) result.command = positionals[1]!
  if (positionals.length > 2) result.arguments = positionals.slice(2).map(quote).join(' ')

  return result
}

function isWslcToken(token: string): boolean {
  let name = token.replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  const slash = name.lastIndexOf('/')
  if (slash >= 0) name = name.slice(slash + 1)
  if (name.toLowerCase().endsWith('.exe')) name = name.slice(0, -4)
  return name.toLowerCase() === 'wslc'
}

function joinQuoted(current: string, ...parts: string[]): string {
  const joined = parts.map(quote).join(' ')
  return current.trim().length === 0 ? joined : `${current.trimEnd()} ${joined}`
}

/** 协议只认 tcp/udp：写 sctp 之类的本来 wslc 也不认，归成 tcp 让表单、命令、校验说同一句话 */
function parsePortSpec(text: string): PortRow {
  const row: PortRow = { hostIp: '', hostPort: '', containerPort: '', protocol: 'tcp' }
  let body = text
  const slash = body.lastIndexOf('/')
  if (slash >= 0) {
    row.protocol = body.slice(slash + 1).toLowerCase() === 'udp' ? 'udp' : 'tcp'
    body = body.slice(0, slash)
  }
  const parts = body.split(':')
  if (parts.length === 1) {
    row.containerPort = parts[0]!
  } else if (parts.length === 2) {
    row.hostPort = parts[0]!
    row.containerPort = parts[1]!
  } else {
    row.hostIp = parts[0]!
    row.hostPort = parts[1]!
    row.containerPort = parts.slice(2).join(':')
  }
  return row
}

/** 盘符里的冒号（`C:\data`）不能当分隔符：index 1 处且后面紧跟反斜杠的冒号属于盘符 */
function parseVolumeSpec(text: string): VolumeRow {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const isDriveColon = i === 1 && /[A-Za-z]/.test(text[0]!) && text.length > 2 && text[2] === '\\'
    if (c === ':' && !isDriveColon) {
      parts.push(current)
      current = ''
    } else {
      current += c
    }
  }
  parts.push(current)
  return {
    source: parts[0] ?? '',
    target: parts[1] ?? '',
    readOnly: (parts[2] ?? '').toLowerCase() === 'ro'
  }
}

/* ---------------- 分词与转义 ---------------- */

/**
 * 引号感知的命令行分词：双引号内部按 CommandLineToArgvW 语义解反斜杠
 * （2n 个 + 引号 → n 个反斜杠、引号定界；2n+1 个 → n 个反斜杠 + 一个字面引号）；
 * 单引号段整段原样（我们从不生成它，只为读回 PowerShell 手写命令时不炸）。
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  if (text.length === 0) return tokens

  let current = ''
  let hasToken = false
  let inQuotes = false
  let i = 0

  const flush = (): void => {
    if (hasToken) {
      tokens.push(current)
      current = ''
      hasToken = false
    }
  }

  while (i < text.length) {
    const c = text[i]!

    if (!inQuotes && (c === ' ' || c === '\t' || c === '\r' || c === '\n')) {
      flush()
      i += 1
      continue
    }

    if (c === '\\') {
      let backslashes = 0
      let j = i
      while (j < text.length && text[j] === '\\') {
        backslashes += 1
        j += 1
      }
      hasToken = true
      if (j < text.length && text[j] === '"') {
        current += '\\'.repeat(Math.floor(backslashes / 2))
        if (backslashes % 2 === 1) current += '"'
        else inQuotes = !inQuotes
        i = j + 1
        continue
      }
      current += '\\'.repeat(backslashes)
      i = j
      continue
    }

    if (c === '"') {
      hasToken = true
      inQuotes = !inQuotes
      i += 1
      continue
    }

    if (c === "'" && !inQuotes) {
      hasToken = true
      i += 1
      while (i < text.length && text[i] !== "'") {
        current += text[i]!
        i += 1
      }
      i += 1
      continue
    }

    hasToken = true
    current += c
    i += 1
  }

  flush()
  return tokens
}

function needsQuotes(token: string): boolean {
  for (const c of token) {
    if (' \t"\';&|<>()^$`'.includes(c)) return true
  }
  return false
}

/** 需要时才加双引号，并按 CommandLineToArgvW 规则转义（" 前与结尾的反斜杠加倍） */
export function quote(token: string): string {
  if (token.length > 0 && !needsQuotes(token)) return token

  let out = '"'
  let backslashes = 0
  for (const c of token) {
    if (c === '\\') {
      backslashes += 1
      out += c
      continue
    }
    if (c === '"') {
      out += '\\'.repeat(backslashes)
      backslashes = 0
      out += '\\"'
      continue
    }
    backslashes = 0
    out += c
  }
  out += '\\'.repeat(backslashes)
  out += '"'
  return out
}

/* ---------------- 执行历史 ---------------- */

/** 只活一个会话、不落盘：它救的是"这条没跑对，我要接着改"的工作现场，不是档案 */
export const HISTORY_CAPACITY = 100

export interface RunHistoryEntry {
  command: string
  /** 列表里显示的本地时间，秒级足够分辨先后 */
  timeText: string
}

export const historyTimeText = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/**
 * 记一条执行过的命令，返回新表：最新在前；与最新一条相同则原表退回（连点两次执行不该长出两条一样的）；
 * 超出 100 条挤掉最旧的。
 */
export function recordRunHistory(
  entries: readonly RunHistoryEntry[],
  command: string,
  at: number
): RunHistoryEntry[] {
  if (command.trim().length === 0) return [...entries]
  if (entries.length > 0 && entries[0]!.command === command) return [...entries]
  const next = [{ command, timeText: historyTimeText(at) }, ...entries]
  return next.slice(0, HISTORY_CAPACITY)
}
