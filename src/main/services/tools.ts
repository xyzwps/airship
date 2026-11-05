import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { settings } from './settings'
import { log } from './logging'

/**
 * 工具发现。
 *
 * 这台机器上没有系统级 ffmpeg，也没有 ffprobe（已确认）：
 * ffmpeg 是 imageio_ffmpeg 带的那个静态 exe。所以这里按顺序找：
 *   1. 壳设置里用户手动指定的路径（最高优先，界面上可以改）
 *   2. PATH 里的 ffmpeg
 *   3. 已知的 imageio_ffmpeg / Python site-packages 位置
 * 找到后登记进可执行文件白名单，proc 服务只跑白名单里的东西。
 */

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

function looksLikeFfmpeg(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('ffmpeg') && (lower.endsWith('.exe') || !lower.includes('.'))
}

function fromPath(): string | null {
  const pathEnv = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* 某个 PATH 条目读不了就跳过 */
    }
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
      if (res.status === 0 && out && existsSync(out)) return out
    } catch {
      /* 没有这个解释器就试下一个 */
    }
  }
  return null
}

let resolved: string | null | undefined

/** 解析 ffmpeg 路径。结果缓存；传 true 强制重新发现。 */
export function ffmpegPath(force = false): string | null {
  if (!force && resolved !== undefined) return resolved

  const override = settings.get<string>('shell', 'ffmpegPath', '')
  const candidates = [
    override || null,
    fromPath(),
    fromPythonModule(),
    fromImageio()
  ].filter((c): c is string => Boolean(c))

  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) {
        resolved = c
        allowExecutable(c)
        log.info('shell', 'ffmpeg 已定位', { path: c, source: c === override ? 'override' : 'discovery' })
        return resolved
      }
    } catch {
      /* 换下一个 */
    }
  }

  log.warn('shell', '没找到 ffmpeg，vcp 将不可用', { tried: candidates })
  resolved = null
  return null
}

/** 用户在界面上手动指定 ffmpeg 后调用：校验 + 记住 + 加白名单 */
export function setFfmpegPath(exe: string): { ok: boolean; error?: string } {
  if (!exe) return { ok: false, error: '路径为空' }
  try {
    if (!existsSync(exe) || !statSync(exe).isFile()) {
      return { ok: false, error: `文件不存在：${exe}` }
    }
    // 跑一次 -version，确认它真是 ffmpeg 而不是同名的别的东西
    const res = spawnSync(exe, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    if (!/ffmpeg version/i.test(out)) {
      return { ok: false, error: '这个可执行文件的 -version 输出里没有 "ffmpeg version"，可能不是 ffmpeg' }
    }
  } catch (err) {
    return { ok: false, error: `无法执行：${String(err)}` }
  }

  settings.set('shell', 'ffmpegPath', exe)
  allowExecutable(exe)
  resolved = exe
  log.info('shell', 'ffmpeg 路径已由用户指定', { path: exe, dir: dirname(exe) })
  return { ok: true }
}
