import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { settings } from './settings'
import { log } from './logging'
import { toolNotVerified } from '@shared/errors'
import { TOOL_NAMES, type ToolName } from '@shared/protocol'

/**
 * 外部工具发现与可执行文件白名单。
 *
 * proc 是最危险的能力，所以能跑的东西只有两个来历：**壳发现的**、或**用户在设置里指定并通过校验的**。
 * 这张表就是"壳发现"的全部知识面——加一个新工具在这儿加一条，应用侧只能声明自己要哪一个。
 *
 * 本机事实（已实测）：没有系统 ffmpeg、也没有 ffprobe，ffmpeg 是 imageio_ffmpeg 带的静态 exe，
 * 所以媒体探测只能解析 `ffmpeg -hide_banner -i` 的 stderr。wslc 由 WSL 3 自带，装在 Program Files\WSL。
 *
 * 每个工具按同一个顺序找：
 *   1. 环境变量显式指定（`AIRSHIP_<NAME>_PATH`，工装与开发用）
 *   2. 壳设置里用户手动指定的路径
 *   3. PATH 里的同名可执行文件
 *   4. 该工具的已知安装位置 / 额外手段
 */

interface ToolSpec {
  name: ToolName
  /** Windows 上的文件名，PATH 扫描按它找 */
  exe: string
  /** `-version` 输出里必须命中的字样：确认"这真是它"，而不是同名别的东西 */
  verify: RegExp
  /** 已知安装位置，按顺序试 */
  knownPaths: () => string[]
  /** 额外手段：扫目录或问解释器 */
  extra?: () => string[]
}

const SPECS: Record<ToolName, ToolSpec> = {
  ffmpeg: {
    name: 'ffmpeg',
    exe: 'ffmpeg.exe',
    verify: /ffmpeg version/i,
    knownPaths: () => [],
    extra: () => [fromPythonModule(), fromImageio()].filter((p): p is string => Boolean(p))
  },
  wslc: {
    name: 'wslc',
    exe: 'wslc.exe',
    verify: /wslc|Windows Subsystem for Linux/i,
    knownPaths: () => [join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WSL', 'wslc.exe')]
  }
}

/** 壳认识哪些工具，由这张表说了算 */
export const KNOWN_TOOLS: readonly ToolName[] = TOOL_NAMES

const allowed = new Set<string>()

export function allowExecutable(exe: string): void {
  allowed.add(normalizeExe(exe))
}

export function isAllowedExecutable(exe: string): boolean {
  return allowed.has(normalizeExe(exe))
}

function normalizeExe(exe: string): string {
  return process.platform === 'win32' ? exe.toLowerCase() : exe
}

/** 用户手动指定的路径记在壳设置里的键名 */
export function toolSettingsKey(name: ToolName): string {
  return `toolPath:${name}`
}

function envKey(name: ToolName): string {
  return `AIRSHIP_${name.toUpperCase()}_PATH`
}

function isFile(p: string | null | undefined): p is string {
  if (!p) return false
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

function looksLikeFfmpeg(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('ffmpeg') && (lower.endsWith('.exe') || !lower.includes('.'))
}

/** PATH 里找同名可执行文件；某个条目读不了就跳过，不让整次发现失败 */
function fromPath(exe: string): string | null {
  const name = process.platform === 'win32' ? exe : exe.replace(/\.exe$/, '')
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (isFile(candidate)) return candidate
  }
  return null
}

/** 在若干根目录下按 glob 摸 imageio_ffmpeg 的静态 exe */
function fromImageio(): string | null {
  const roots = [
    process.env.APPDATA && join(process.env.APPDATA, 'Python'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Python'),
    'C:\\Python313',
    'C:\\Python312',
    'C:\\Python311'
  ].filter((r): r is string => Boolean(r))

  for (const root of roots) {
    let pythons: string[] = []
    try {
      pythons = readdirSync(root)
    } catch {
      continue
    }
    for (const py of pythons) {
      // 两种装法：%APPDATA%/Python/Python313/site-packages 和 <安装目录>/Lib/site-packages
      const candidates = [
        join(root, py, 'site-packages', 'imageio_ffmpeg', 'binaries'),
        join(root, py, 'Lib', 'site-packages', 'imageio_ffmpeg', 'binaries')
      ]
      for (const dir of candidates) {
        let files: string[] = []
        try {
          files = readdirSync(dir)
        } catch {
          continue
        }
        const hit = files.filter(looksLikeFfmpeg).sort().pop()
        if (hit) return join(dir, hit)
      }
    }
  }
  return null
}

/** 问 imageio_ffmpeg 自己要路径，最准，但要求 python 在 PATH 上 */
function fromPythonModule(): string | null {
  for (const py of ['python', 'python3', 'py']) {
    try {
      const res = spawnSync(
        py,
        ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true }
      )
      const out = (res.stdout ?? '').trim()
      if (res.status === 0 && isFile(out)) return out
    } catch {
      /* 没有这个解释器就试下一个 */
    }
  }
  return null
}

const resolved = new Map<ToolName, string | null>()

/** 解析工具路径。结果缓存；force 为真时重新发现。 */
export function toolPath(name: ToolName, force = false): string | null {
  if (!force && resolved.has(name)) return resolved.get(name) ?? null

  const spec = SPECS[name]
  const override = settings.get<string>('shell', toolSettingsKey(name), '')
  const candidates = [
    process.env[envKey(name)] || null,
    override || null,
    fromPath(spec.exe),
    ...spec.knownPaths(),
    ...(spec.extra ? spec.extra() : [])
  ].filter((c): c is string => Boolean(c))

  for (const c of candidates) {
    if (isFile(c)) {
      resolved.set(name, c)
      allowExecutable(c)
      log.info('shell', `${name} 已定位`, { path: c, source: c === override ? 'override' : 'discovery' })
      return c
    }
  }

  log.warn('shell', `没找到 ${name}，依赖它的应用会报不可用`, { tried: candidates })
  resolved.set(name, null)
  return null
}

/** 用户在界面上手动指定后调用：跑一次 -version 校验，通过了才记住、才进白名单 */
export function setToolPath(name: ToolName, exe: string): { ok: boolean; error?: string } {
  const spec = SPECS[name]
  if (!exe) return { ok: false, error: '路径为空' }
  try {
    if (!isFile(exe)) return { ok: false, error: `文件不存在：${exe}` }
    const res = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    if (!spec.verify.test(out)) return { ok: false, error: toolNotVerified(name, out) }
  } catch (err) {
    return { ok: false, error: `无法执行：${String(err)}` }
  }

  settings.set('shell', toolSettingsKey(name), exe)
  allowExecutable(exe)
  resolved.set(name, exe)
  log.info('shell', `${name} 路径已由用户指定`, { path: exe })
  return { ok: true }
}

/** 各工具现在定位到什么，诊断界面用 */
export function toolStatus(): Record<ToolName, string | null> {
  const out = {} as Record<ToolName, string | null>
  for (const name of TOOL_NAMES) out[name] = toolPath(name)
  return out
}

/** 工装：清掉发现缓存与白名单，让下一条用例从干净状态开始 */
export function resetToolDiscovery(): void {
  resolved.clear()
  allowed.clear()
}
