// @vitest-environment jsdom
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeAirship, mountUi } from '@airship/sdk/testing'
import { Titlebar, useTheme } from '@airship/sdk'
import type { ThemeSnapshot } from '@airship/contract'

/**
 * TH-002 ~ TH-015：每个应用各改各的主题档。
 *
 * 渲染侧对着真 SDK（Titlebar + useTheme）与 FakeAirship 验；
 * 主进程侧对着真 ipc.ts 的 theme:set / readThemeFor，配一个每次清空的临时 userData——
 * "改一个应用的档不许碰另一个应用的文件"只能对着真实文件系统验。
 * 窗口归属用一张固定的 sender.id → 应用映射替掉台账（theme:set 只问归属，不开窗口）。
 */

const ROOT = join(__dirname, '.tmp', 'theme-home')
/** 替身 electron 的 getPath('home') 给出的家：应用那族目录在它下面的 data/<id> */
const AIRSHIP = join(ROOT, '.airship')

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: string }>>(),
  owners: { 101: 'airship-ffmpeg', 102: 'airship-reader', 103: 'airship-life-game', 104: 'airship-s3' } as Record<number, string>
}))

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  const root = p(__dirname, '.tmp', 'theme-home')
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    ipcMain: {
      handle: (channel: string, fn: never) => ipc.handlers.set(channel, fn),
      on: () => undefined
    },
    BrowserWindow: Object.assign(class {}, { fromWebContents: () => null }),
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
    clipboard: { writeText: () => undefined, readText: () => '' },
    dialog: {},
    Notification: class {
      static isSupported(): boolean {
        return false
      }
    },
    shell: { openExternal: async () => undefined }
  }
})

vi.mock('../main/windows', () => ({
  ownerOfContents: (id: number) => ipc.owners[id] ?? null,
  bringAppToFront: () => undefined,
  sendTo: () => undefined
}))

const { registerIpc, readThemeFor } = await import('../main/ipc')
registerIpc()

const prefs = globalThis as unknown as { __prefersDark: boolean }

/** 走真的 theme:set 通道（handle 包了一层 { ok, value }） */
function setTheme(senderId: number, mode: string, hint?: 'light' | 'dark'): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  const fn = ipc.handlers.get('theme:set')
  if (!fn) throw new Error('theme:set 没注册')
  return fn({ sender: { id: senderId } }, mode, hint)
}

function resetDisk(app: string): void {
  // 只清这个应用自己那份：settings 的内存缓存没法按用例重置，所以每条用例占一个应用
  rmSync(join(AIRSHIP, 'data', app), { recursive: true, force: true })
  mkdirSync(join(AIRSHIP, 'data'), { recursive: true })
}

function fileOf(app: string): string {
  return join(AIRSHIP, 'data', app, 'settings.json')
}

/** 记下主题键发给 runtime 的每一次请求 */
function spyTheme(fake: FakeAirship): Array<[string, string | undefined]> {
  const calls: Array<[string, string | undefined]> = []
  const orig = fake.setTheme.bind(fake)
  fake.setTheme = async (mode, hint) => {
    calls.push([mode, hint])
    return orig(mode, hint)
  }
  return calls
}

/** 标题栏控制区的第一颗键就是主题键 */
const THEME_BTN = '.titlebar__controls button:first-child'

async function mountTitlebar(theme: ThemeSnapshot): Promise<{ m: Awaited<ReturnType<typeof mountUi>>; fake: FakeAirship; calls: Array<[string, string | undefined]> }> {
  const fake = new FakeAirship({ id: 'airship-ffmpeg', theme })
  const calls = spyTheme(fake)
  const m = await mountUi(<Titlebar here="用例" />, { fake })
  return { m, fake, calls }
}

/** 把 useTheme 给不给 setter 摆到台面上看 */
function Probe({ onResult }: { onResult: (canChange: boolean) => void }): null {
  const t = useTheme()
  onResult(t.setMode !== undefined)
  return null
}

beforeEach(() => {
  prefs.__prefersDark = false
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  document.documentElement.dataset.theme = ''
})

describe('每个应用改自己的主题档', () => {
  it('TH-002 应用改得了自己的主题，不碰设置面', async () => {
    // 渲染侧：窗口拿得到 setter，不存在"只读"的答复
    const seen: boolean[] = []
    const m = await mountUi(<Probe onResult={(c) => seen.push(c)} />, {
      fake: new FakeAirship({ id: 'airship-life-game' })
    })
    expect(seen.at(-1)).toBe(true)
    m.unmount()

    // 主进程侧：生命游戏不写任何名单，theme:set 照样落进它自己那份设置文件
    resetDisk('airship-life-game')
    const res = await setTheme(103, 'dark')
    expect(res.ok, res.error).toBe(true)
    expect(res.value).toEqual({ mode: 'dark', resolved: 'dark' })
    const stored = JSON.parse(readFileSync(fileOf('airship-life-game'), 'utf8')) as Record<string, unknown>
    expect(stored['theme']).toEqual({ mode: 'dark' })
  })

  it('TH-004 亮暗两档是直接落定的实际结果', async () => {
    const { m, calls } = await mountTitlebar({ mode: 'dark', resolved: 'dark' })
    // 暗色的下一档是亮色：mode 与实际结果都是 light，不需要 hint
    await m.pressIn(THEME_BTN)
    expect(calls).toEqual([['light', undefined]])
    expect(document.documentElement.dataset.theme).toBe('light')
    m.unmount()
  })

  it('TH-012 标题栏上那颗主题键是图标，三档循环', async () => {
    const { m, calls } = await mountTitlebar({ mode: 'system', resolved: 'light' })
    expect(m.container.querySelector('select'), '界面上不该有主题下拉框').toBeNull()

    const glyph = (): string => m.container.querySelector(THEME_BTN)!.innerHTML.replace(/\s+/g, '')
    const glyphs = [glyph()]
    for (let i = 0; i < 4; i++) {
      await m.pressIn(THEME_BTN)
      glyphs.push(glyph())
    }
    // 跟随系统 → 暗 → 亮 → 跟随系统 → 暗：不倒退也不跳档
    expect(calls).toEqual([['dark', undefined], ['light', undefined], ['system', 'light'], ['dark', undefined]])
    expect(new Set(glyphs).size, '三档画出来的图形必须互不相同').toBe(3)
    // 形状各是各的：半明半暗的圆 / 月牙 / 太阳（glyph() 剥掉了全部空白，形状串也按剥后的比）
    expect(glyphs[0]).toContain('a6.26.2001012.4')
    expect(glyphs[1]).toContain('M10.2')
    expect(glyphs[2]).toContain('r="3.1"')
    m.unmount()
  })

  it('TH-013 那颗纯图标键念得出"现在哪档、点一下换成哪档"', async () => {
    const { m } = await mountTitlebar({ mode: 'dark', resolved: 'dark' })
    const btn = m.container.querySelector(THEME_BTN)!
    expect(btn.getAttribute('title')).toBe('主题：暗色（点一下换成亮色）')
    expect(btn.getAttribute('aria-label')).toBe('主题：暗色，点一下换成亮色')
    m.unmount()
  })

  it('TH-014 改档只动这个应用，别的应用不跟着变', async () => {
    resetDisk('airship-ffmpeg')
    resetDisk('airship-reader')
    await setTheme(102, 'system', 'light') // books 先记好自己的档
    const booksBefore = readThemeFor('airship-reader')
    const booksBytes = readFileSync(fileOf('airship-reader'))

    const res = await setTheme(101, 'light') // vcp 改成亮色
    expect(res.ok, res.error).toBe(true)
    expect(readThemeFor('airship-ffmpeg')).toEqual({ mode: 'light', resolved: 'light' })
    expect(readThemeFor('airship-reader')).toEqual(booksBefore)
    expect(readFileSync(fileOf('airship-reader')).equals(booksBytes), 'books 那份设置文件一个字节没变').toBe(true)

    // 不存在主题广播通道：改档的请求只写自己那份设置
    const source = readFileSync(join(__dirname, '..', 'main', 'ipc.ts'), 'utf8')
    expect(source).not.toContain('theme:changed')
  })

  it('TH-015 "跟随系统"的实际亮暗由本窗口算好交给 runtime', async () => {
    prefs.__prefersDark = true
    const { m, calls } = await mountTitlebar({ mode: 'light', resolved: 'light' })
    // 亮色的下一档是跟随系统：实际亮暗由本窗口的 matchMedia 算出（此时系统偏好是暗）
    await m.pressIn(THEME_BTN)
    expect(calls).toEqual([['system', 'dark']])
    m.unmount()

    // 主进程自己不去猜系统偏好：它没有 matchMedia，也不读 nativeTheme（剥掉注释再扫，注释里提到不算）
    const source = readFileSync(join(__dirname, '..', 'main', 'ipc.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    expect(source).not.toMatch(/matchMedia|nativeTheme/)
  })
})

describe('每个窗口自己把主题落到文档上', () => {
  it('TH-005 窗口挂载后 <html> 带着实际生效的亮暗，变更来了跟着换', async () => {
    const { m } = await mountTitlebar({ mode: 'dark', resolved: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    await m.pressIn(THEME_BTN) // 生效值换成亮色，同一份文档跟着变
    expect(document.documentElement.dataset.theme).toBe('light')
    m.unmount()
  })

  it('TH-006 桥还没回话时先按系统偏好画', async () => {
    prefs.__prefersDark = true
    const fake = new FakeAirship({ id: 'airship-ffmpeg' })
    fake.theme = () => new Promise<ThemeSnapshot>(() => undefined)
    const m = await mountUi(<Probe onResult={() => undefined} />, { fake })
    expect(document.documentElement.dataset.theme).toBe('dark')
    m.unmount()
  })
})

describe('主进程读主题时不编造实际值', () => {
  it('TH-008 没记过主题时读出来是跟随系统', async () => {
    resetDisk('airship-dago')
    expect(readThemeFor('airship-dago')).toEqual({ mode: 'system', resolved: 'light' })
  })

  it('TH-009 写过的档位原样读回', async () => {
    resetDisk('airship-s3')
    expect((await setTheme(104, 'dark')).value).toEqual({ mode: 'dark', resolved: 'dark' })
    expect(readThemeFor('airship-s3')).toEqual({ mode: 'dark', resolved: 'dark' })

    // system 档回落到上次实际生效的那档
    expect((await setTheme(104, 'system', 'dark')).value).toEqual({ mode: 'system', resolved: 'dark' })
    expect(readThemeFor('airship-s3')).toEqual({ mode: 'system', resolved: 'dark' })

    // 落盘的就是那两个键，且在应用自己那份文件里
    const stored = JSON.parse(readFileSync(fileOf('airship-s3'), 'utf8')) as Record<string, unknown>
    expect(Object.keys(stored).sort()).toEqual(['lastResolved', 'theme'])
  })
})