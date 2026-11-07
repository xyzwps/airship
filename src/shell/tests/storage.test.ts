import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ST-001 ~ ST-007：设置与数据的落盘规矩。
 *
 * 跑的是真 settings.ts，配一个每次清空的临时 userData——
 * "写坏了怎么办"这类契约只能对着真实文件系统验，替身里磁盘永远是好的。
 */

const ROOT = join(__dirname, '.tmp', 'settings-userData')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return {
    app: { getPath: () => p(__dirname, '.tmp', 'settings-userData'), getVersion: () => '0.0.0-test' }
  }
})

const { settings } = await import('../main/services/settings')
const { appSettingsFile, shellSettingsFile } = await import('../main/services/paths')

function resetDisk(app: string): void {
  // 只清这个应用自己的那份文件：整棵 ROOT 删掉会连带把 logs/ 端了，
  // 而 ST-004 那条正读同一天的日志——套件偶发红就是这么来的。
  // settings 的内存缓存没法按用例重置，所以每条用例占一个应用、键名也各自独立。
  rmSync(join(ROOT, 'apps', app), { recursive: true, force: true })
  mkdirSync(join(ROOT, 'apps'), { recursive: true })
}

function fileOf(app: string): string {
  return app === 'shell' ? shellSettingsFile() : appSettingsFile(app)
}

describe('每应用一份设置，壳自己一份', () => {
  it('ST-001 应用之间看不到彼此的设置，磁盘上是两份文件', () => {
    // 这条要断言"pdf 那份文件不存在"，所以先把两边都清干净，别留上一轮的
    resetDisk('vcp')
    resetDisk('pdf')
    settings.set('vcp', 'prefs', { crf: 20 })
    expect(settings.get('pdf', 'prefs', null)).toBeNull()
    expect(settings.get('vcp', 'prefs', null)).toEqual({ crf: 20 })

    expect(existsSync(fileOf('vcp'))).toBe(true)
    expect(existsSync(fileOf('pdf'))).toBe(false)
    expect(join(fileOf('vcp')).replace(/\\/g, '/')).toMatch(/apps\/vcp\/settings\.json$/)
    expect(fileOf('shell').replace(/\\/g, '/')).toMatch(/settings-userData\/settings\.json$/)
  })

  it('ST-002 写 undefined 等于删掉这个键', () => {
    settings.set('vcp', 'temp', '留着')
    settings.set('vcp', 'temp', undefined)
    expect(settings.get('vcp', 'temp', '回落值')).toBe('回落值')
    const stored = JSON.parse(readFileSync(fileOf('vcp'), 'utf8')) as Record<string, unknown>
    expect('temp' in stored).toBe(false)
  })
})

describe('落盘是"临时文件 + 改名"', () => {
  it('ST-003 写完只剩正式文件，内容是完整 JSON', () => {
    resetDisk('books')
    settings.set('books', 'prefs', { fontScale: 1.2 })
    expect(existsSync(`${fileOf('books')}.tmp`)).toBe(false)
    const text = readFileSync(fileOf('books'), 'utf8')
    expect(JSON.parse(text)).toEqual({ prefs: { fontScale: 1.2 } })
    expect(text).toContain('\n  "prefs"')
  })
})

describe('坏文件不致命', () => {
  it('ST-004 解析失败就改名留证、记日志、从空开始', () => {
    resetDisk('dagogo')
    mkdirSync(join(ROOT, 'apps', 'dagogo'), { recursive: true })
    writeFileSync(fileOf('dagogo'), '{ 残缺', 'utf8')

    expect(settings.get('dagogo', 'anything', '回落')).toBe('回落')
    expect(existsSync(fileOf('dagogo'))).toBe(false)
    expect(existsSync(`${fileOf('dagogo')}.bad`)).toBe(true)

    const day = new Date()
    const logFile = join(ROOT, 'logs', `airship-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.log`)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(log).toContain('设置文件解析失败，已重置')
  })

  it('ST-005 顶层是数组时同样从空开始', () => {
    resetDisk('pdf')
    mkdirSync(join(ROOT, 'apps', 'pdf'), { recursive: true })
    writeFileSync(fileOf('pdf'), '[1,2,3]', 'utf8')
    expect(settings.get('pdf', 'k', '回落')).toBe('回落')
    expect(settings.dump('pdf')).toEqual({})
  })
})

describe('连续写与副本', () => {
  it('ST-006 连着写两笔，最后一份文件里两笔都在', () => {
    resetDisk('vcp')
    settings.set('vcp', 'a', 1)
    settings.set('vcp', 'b', 2)
    const stored = JSON.parse(readFileSync(fileOf('vcp'), 'utf8')) as Record<string, unknown>
    expect({ a: stored['a'], b: stored['b'] }).toEqual({ a: 1, b: 2 })
  })

  it('ST-007 一次拿全是副本，改它不影响壳里那份', () => {
    resetDisk('vcp')
    settings.set('vcp', 'keep', '原值')
    const dump = settings.dump('vcp')
    dump['keep'] = '被外面改了'
    expect(settings.get('vcp', 'keep', '?')).toBe('原值')
  })

  /**
   * ST-008：装好之后第一次读写就能落进自己的目录。
   *
   * 这条钉的是 paths.ts 不许再把"当前有哪些应用"缓存成一张启动时的快照——
   * 拖放装包会重扫注册表，那张缓存不会跟着变，于是新装的应用一读写就撞
   * undefined (reading 'data')（2026-11-07 真机撞过，每个应用都中招）。
   * 这里故意用一个注册表从来没见过的 id：老实现拿不到目录，新实现当场建出来。
   */
  it('ST-008 壳跑起来之后才装的应用，第一次读写就有自己的目录', async () => {
    const late = 'late-installed'
    resetDisk(late)
    const { paths, appDataDir, appCacheDir, appSettingsFile } = await import('../main/services/paths')
    // 先把缓存打出来：这一步模拟"壳刚启动、还不知道有这个应用"的那一刻
    const before = paths()
    expect(before.shared['library'], '共享区照旧在').toBeTruthy()

    const data = appDataDir(late)
    expect(data).toBe(join(before.root, 'apps', late, 'data'))
    expect(existsSync(data), '目录要当场建出来').toBe(true)
    expect(existsSync(appCacheDir(late)), 'cache 同理').toBe(true)

    settings.set(late, 'first', '装好之后写的第一笔')
    expect(settings.get(late, 'first', '?')).toBe('装好之后写的第一笔')
    expect(existsSync(appSettingsFile(late)), '设置文件落在它自己那份上').toBe(true)
    // 第二次拿同一个 id 还是同一条路径：现算不等于每次换地方
    expect(appDataDir(late)).toBe(data)
  })
})
