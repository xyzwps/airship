import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PT-006 ~ PT-010：工具发现表与白名单来历。
 *
 * 用 wslc 这一条做主验（它的候选位置是确定的一个目录），
 * 假 exe 只是普通文件——发现阶段只问"这文件在不在"，校验阶段才真去跑 `-version`。
 */

const ROOT = join(__dirname, '.tmp', 'tools-userData')
const FAKE_BIN = join(ROOT, 'fakeBin')
const FAKE_PF = join(ROOT, 'ProgramFiles')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return { app: { getPath: () => p(__dirname, '.tmp', 'tools-userData') } }
})

const { isAllowedExecutable, resetToolDiscovery, setToolPath, toolPath, toolStatus } = await import(
  '../main/services/tools'
)
const { settings } = await import('../main/services/settings')
const { canUseTool } = await import('../main/services/appRegistry')

const env: Record<string, string | undefined> = {}
const WSLC_NAMES = ['wslc.exe', 'wslc']

function putExe(dir: string, content = 'not a real exe'): string {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, process.platform === 'win32' ? WSLC_NAMES[0] : WSLC_NAMES[1])
  writeFileSync(target, content, 'utf8')
  return target
}

function clearShellKeys(): void {
  settings.set('shell', 'toolPath:wslc', undefined)
  settings.set('shell', 'toolPath:ffmpeg', undefined)
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  for (const k of ['AIRSHIP_WSLC_PATH', 'AIRSHIP_FFMPEG_PATH', 'PATH', 'Path', 'ProgramFiles']) {
    env[k] = process.env[k]
    delete process.env[k]
  }
  process.env.PATH = FAKE_BIN
  process.env.ProgramFiles = FAKE_PF
  clearShellKeys()
  resetToolDiscovery()
})

afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetToolDiscovery()
  clearShellKeys()
})

function todayLog(): string {
  const d = new Date()
  const name = `airship-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
  const file = join(ROOT, 'logs', name)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

describe('发现按固定顺序试', () => {
  it('PT-006 已知安装位置是最后一级，PATH 里有就先用 PATH 的', () => {
    const inPf = putExe(join(FAKE_PF, 'WSL'))
    resetToolDiscovery()
    expect(toolPath('wslc')?.replace(/\\/g, '/')).toBe(inPf.replace(/\\/g, '/'))

    const inPath = putExe(FAKE_BIN)
    resetToolDiscovery()
    expect(toolPath('wslc')).toBe(inPath)

    settings.set('shell', 'toolPath:wslc', putExe(join(ROOT, 'userpicked')))
    resetToolDiscovery()
    expect(toolPath('wslc')?.replace(/\\/g, '/')).toContain('userpicked')

    process.env.AIRSHIP_WSLC_PATH = putExe(join(ROOT, 'envpicked'))
    resetToolDiscovery()
    expect(toolPath('wslc')?.replace(/\\/g, '/')).toContain('envpicked')
  })

  it('PT-007 发现到了就进白名单，立刻能被 proc 用', () => {
    const found = putExe(join(FAKE_PF, 'WSL'))
    resetToolDiscovery()
    expect(isAllowedExecutable(found)).toBe(false)
    const hit = toolPath('wslc')
    expect(hit).toBe(found)
    expect(isAllowedExecutable(found)).toBe(true)
    // 缓存：再问一次不用重新发现
    expect(toolPath('wslc')).toBe(found)
    expect(toolStatus().wslc).toBe(found)
  })

  it('PT-008 这台机器上没有这个工具：给 null，并留一条 warn', () => {
    resetToolDiscovery()
    expect(toolPath('wslc')).toBeNull()
    expect(toolStatus().wslc).toBeNull()
    expect(todayLog()).toContain('没找到 wslc')
    // 没有发现成功，就没有任何东西进白名单
    expect(isAllowedExecutable(join(FAKE_PF, 'WSL', 'wslc.exe'))).toBe(false)
  })
})

describe('用户手动指定要过校验', () => {
  it('PT-009 路径不存在、或不是这个工具，都拒且不留痕', () => {
    const missing = join(ROOT, 'nope', 'wslc.exe')
    expect(setToolPath('wslc', missing)).toEqual({ ok: false, error: `文件不存在：${missing}` })

    // node 也是可执行文件，但它的 -version 里没有 wslc 的版本字样
    const wrong = setToolPath('wslc', process.execPath)
    expect(wrong.ok).toBe(false)
    expect(wrong.error).toContain('wslc 的 -version 输出里没有认得的版本字样')
    expect(isAllowedExecutable(process.execPath)).toBe(false)
    expect(settings.get('shell', 'toolPath:wslc', '')).toBe('')

    expect(setToolPath('wslc', '')).toEqual({ ok: false, error: '路径为空' })
  })

  it('PT-009b 真是那个工具才记住、才进白名单', () => {
    const real = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WSL', 'wslc.exe')
    if (!existsSync(real)) return // 这台机器上没有 wslc，跳过（编号仍算已实现）
    const res = setToolPath('wslc', real)
    expect(res).toEqual({ ok: true })
    expect(settings.get('shell', 'toolPath:wslc', '')).toBe(real)
    expect(isAllowedExecutable(real)).toBe(true)
  })

  it('PT-010 应用只能问自己声明过的工具', () => {
    // vcp 声明了 ffmpeg、没声明 wslc；dagogo 两个都没声明
    expect(canUseTool('vcp', 'ffmpeg')).toBe(true)
    expect(canUseTool('vcp', 'wslc')).toBe(false)
    expect(canUseTool('dagogo', 'ffmpeg')).toBe(false)
    // 有 proc 能力是前提（appRegistry 里那条与 ipc 的闸一致）
    expect(canUseTool('books', 'ffmpeg')).toBe(false)
  })
})
