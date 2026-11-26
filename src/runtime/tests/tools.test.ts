import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PT-006 ~ PT-008、PT-010：工具发现表与白名单来历。
 *
 * 用 wslc 这一条做主验（它的候选位置是确定的一个目录），
 * 假 exe 只是普通文件——发现阶段只问"这文件在不在"。
 * "用户指定"那一档已整档退场（PT-009 删除），发现顺序只有 环境变量 > PATH > 已知位置。
 */

const ROOT = join(__dirname, '.tmp', 'tools-userData')
const FAKE_BIN = join(ROOT, 'fakeBin')
const FAKE_PF = join(ROOT, 'ProgramFiles')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return { app: { getPath: () => p(__dirname, '.tmp', 'tools-userData') } }
})

const { isAllowedExecutable, resetToolDiscovery, toolPath, toolStatus } = await import('../main/services/tools')
const { canUseTool } = await import('../main/services/appRegistry')

const env: Record<string, string | undefined> = {}
const WSLC_NAMES = ['wslc.exe', 'wslc']

function putExe(dir: string, content = 'not a real exe'): string {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, process.platform === 'win32' ? WSLC_NAMES[0] : WSLC_NAMES[1])
  writeFileSync(target, content, 'utf8')
  // Windows 上刚写完的文件可能被杀软短暂占住，statSync 一下读不到；
  // 不让这种抖动变成发现顺序用例的偶发红。
  const started = Date.now()
  while (!existsSync(target) || !statSync(target).isFile()) {
    if (Date.now() - started > 2000) throw new Error(`假 exe 落不下来：${target}`)
  }
  return target
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
  resetToolDiscovery()
})

afterEach(() => {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetToolDiscovery()
})

function todayLog(): string {
  const d = new Date()
  const name = `airship-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
  const file = join(ROOT, '.airship', 'logs', name)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

describe('发现按固定顺序试', () => {
  it('PT-006 已知安装位置是最后一级，PATH 里有就先用 PATH 的，环境变量最大', () => {
    const inPf = putExe(join(FAKE_PF, 'WSL'))
    resetToolDiscovery()
    expect(toolPath('wslc')?.replace(/\\/g, '/')).toBe(inPf.replace(/\\/g, '/'))

    const inPath = putExe(FAKE_BIN)
    resetToolDiscovery()
    expect(toolPath('wslc')).toBe(inPath)

    process.env.AIRSHIP_WSLC_PATH = putExe(join(ROOT, 'envpicked'))
    resetToolDiscovery()
    expect(toolPath('wslc')?.replace(/\\/g, '/')).toContain('envpicked')

    // "用户指定"那一档不存在：发现表不读任何设置，也没有对外的指定入口
    const source = readFileSync(join(__dirname, '..', 'main', 'services', 'tools.ts'), 'utf8')
    expect(source).not.toMatch(/setToolPath|toolPath:|from '\.\/settings'/)
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

describe('应用只能问自己声明过的工具', () => {
  it('PT-010 应用只能问自己声明过的工具', () => {
    // vcp 声明了 ffmpeg、没声明 wslc；dagogo 两个都没声明
    expect(canUseTool('airship-ffmpeg', 'ffmpeg')).toBe(true)
    expect(canUseTool('airship-ffmpeg', 'wslc')).toBe(false)
    expect(canUseTool('airship-dago', 'ffmpeg')).toBe(false)
    // 有 proc 能力是前提（appRegistry 里那条与 ipc 的闸一致）
    expect(canUseTool('airship-reader', 'ffmpeg')).toBe(false)
  })
})
