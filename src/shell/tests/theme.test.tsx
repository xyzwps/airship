// @vitest-environment jsdom
import { readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAirship } from './helpers/fakeAirship'
import { mountUi, type Mount } from './helpers/mount'
import { Launcher } from '../Launcher'
import { useTheme } from '../theme'

/**
 * TH-001 ~ TH-009：三档主题的选定与落地。
 */

const ROOT = join(process.cwd(), 'tests', '.tmp', 'theme-userData')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  const root = p(process.cwd(), 'tests', '.tmp', 'theme-userData')
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    ipcMain: { handle: () => undefined, on: () => undefined },
    BrowserWindow: Object.assign(class {}, { fromWebContents: () => null }),
    clipboard: { writeText: () => undefined, readText: () => '' },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
    },
    shell: { openExternal: async () => undefined }
  }
})

const prefs = globalThis as unknown as { __prefersDark: boolean }

/** 把 useTheme 的结果摆到界面上看：能不能改、落到文档上没有 */
function Probe({ onResult }: { onResult: (r: { mode: string; resolved: string; canChange: boolean }) => void }) {
  const t = useTheme()
  onResult({ mode: t.mode, resolved: t.resolved, canChange: t.setMode !== undefined })
  return null
}

async function mountLauncher(
  theme: { mode: 'light' | 'dark' | 'system'; resolved: 'light' | 'dark' } | undefined,
  calls: Array<[string, string | undefined]>
): Promise<{ m: Mount; fake: FakeAirship }> {
  const fake = new FakeAirship({ id: 'launcher', capabilities: [], theme })
  const m = await mountUi(<Launcher />, {
    fake,
    shell: {
      currentPlatform: async () => 'windows',
      openApp: async () => undefined,
      setTheme: async (mode, hint) => {
        calls.push([mode, hint])
        return { mode, resolved: hint ?? (mode === 'system' ? 'dark' : mode) } as never
      },
      theme: async () => ({ mode: 'system', resolved: 'dark' })
    }
  })
  return { m, fake }
}

describe('主题只有启动器能改', () => {
  beforeEach(() => {
    prefs.__prefersDark = false
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    document.documentElement.dataset.theme = ''
  })

  it('TH-001 启动器读得到三档，档位名字就是那三档', async () => {
    const calls: Array<[string, string | undefined]> = []
    const { m } = await mountLauncher({ mode: 'system', resolved: 'dark' }, calls)
    await m.settle()

    const select = m.container.querySelector('select')
    expect(select).not.toBeNull()
    const options = Array.from(select!.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).toEqual(['跟随系统', '亮色', '暗色'])
    expect((select as HTMLSelectElement).value).toBe('system')
    m.unmount()
  })

  it('TH-002 应用窗口里改不了主题，启动器里才给得出 setter', async () => {
    const seen: boolean[] = []
    // 应用窗口：只有 airship，没有 airshipShell
    const appSide = await mountUi(<Probe onResult={(r) => seen.push(r.canChange)} />, {
      fake: new FakeAirship({ id: 'vcp', capabilities: ['log'] })
    })
    expect(seen.at(-1)).toBe(false)
    appSide.unmount()

    // 启动器：两套面都有
    const shellSide = await mountUi(<Probe onResult={(r) => seen.push(r.canChange)} />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        currentPlatform: async () => 'windows',
        openApp: async () => undefined,
        setTheme: async (mode, hint) => ({ mode: mode === 'system' ? 'system' : mode, resolved: hint ?? 'dark' }),
        theme: async () => ({ mode: 'system', resolved: 'dark' })
      }
    })
    expect(seen.at(-1)).toBe(true)
    shellSide.unmount()

    // 应用界面里没有任何改主题的入口：只有启动器那一屏有下拉
    const launcher = await mountLauncher({ mode: 'dark', resolved: 'dark' }, [])
    await launcher.m.settle()
    expect(launcher.m.container.querySelector('select')).not.toBeNull()
    launcher.m.unmount()
  })

  it('TH-003 "跟随系统"的实际亮暗由启动器算好交给壳', async () => {
    prefs.__prefersDark = true
    const calls: Array<[string, string | undefined]> = []
    const { m } = await mountLauncher({ mode: 'light', resolved: 'light' }, calls)
    await m.settle()

    await m.select('主题', 'system')
    expect(calls).toEqual([['system', 'dark']])
    m.unmount()
  })

  it('TH-004 亮暗两档是直接落定的实际结果', async () => {
    const calls: Array<[string, string | undefined]> = []
    const { m } = await mountLauncher({ mode: 'system', resolved: 'dark' }, calls)
    await m.settle()

    await m.select('主题', 'light')
    expect(calls).toEqual([['light', undefined]])
    m.unmount()
  })
})

describe('每个窗口自己把主题落到文档上', () => {
  it('TH-005 窗口挂载后 <html> 带着实际生效的亮暗，变更来了跟着换', async () => {
    const fake = new FakeAirship({ id: 'vcp', capabilities: ['log'], theme: { mode: 'dark', resolved: 'dark' } })
    const m = await mountUi(<Probe onResult={() => undefined} />, { fake })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    fake.emit({ kind: 'theme:changed', value: { mode: 'light', resolved: 'light' } })
    await m.settle()
    expect(document.documentElement.dataset.theme).toBe('light')
    m.unmount()
  })

  it('TH-006 桥还没回话时先按系统偏好画', async () => {
    prefs.__prefersDark = true
    const never = { theme: async () => new Promise<never>(() => undefined) }
    Object.assign(new FakeAirship({ id: 'vcp', capabilities: ['log'] }), {})
    const fake = new FakeAirship({ id: 'vcp', capabilities: ['log'] })
    fake.theme = never.theme
    const m = await mountUi(<Probe onResult={() => undefined} />, { fake })
    expect(document.documentElement.dataset.theme).toBe('dark')
    m.unmount()
  })

  it('TH-007 壳广播主题变更，窗口在同一趟里跟上', async () => {
    const fake = new FakeAirship({ id: 'books', capabilities: ['log'], theme: { mode: 'system', resolved: 'light' } })
    const seen: string[] = []
    const m = await mountUi(
      <Probe
        onResult={(r) => {
          seen.push(`${r.mode}:${r.resolved}`)
        }}
      />,
      { fake }
    )
    expect(document.documentElement.dataset.theme).toBe('light')
    fake.emit({ kind: 'theme:changed', value: { mode: 'dark', resolved: 'dark' } })
    await m.settle()
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(seen.at(-1)).toBe('dark:dark')
    m.unmount()
  })
})

describe('主进程读主题时不编造实际值', () => {
  it('TH-008 没记过主题时读出来是跟随系统', async () => {
    const { readTheme } = await import('../main/ipc')
    const { settings } = await import('../main/services/settings')
    settings.set('shell', 'theme', undefined)
    settings.set('shell', 'lastResolved', undefined)
    expect(readTheme()).toEqual({ mode: 'system', resolved: 'light' })
  })

  it('TH-009 写过的档位原样读回；system 档回落到上次实际生效的那档', async () => {
    const { readTheme } = await import('../main/ipc')
    const { settings } = await import('../main/services/settings')
    settings.set('shell', 'theme', { mode: 'dark' })
    expect(readTheme()).toEqual({ mode: 'dark', resolved: 'dark' })

    settings.set('shell', 'lastResolved', 'dark')
    settings.set('shell', 'theme', { mode: 'system' })
    expect(readTheme()).toEqual({ mode: 'system', resolved: 'dark' })

    // 落盘的就是那两个键
    const stored = JSON.parse(readFileSync(join(ROOT, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['lastResolved', 'theme'])
  })
})
