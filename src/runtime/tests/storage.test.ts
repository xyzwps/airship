import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ST-001 ~ ST-007：设置与数据的落盘规矩。
 *
 * 跑的是真 settings.ts，配一个每次清空的临时主目录（airship 的家是它下面的 .airship）——
 * "写坏了怎么办"这类契约只能对着真实文件系统验，替身里磁盘永远是好的。
 */

const ROOT = join(__dirname, '.tmp', 'settings-home')
/** 替身 electron 的 getPath('home') 给出的家：布局真源在这里派生（paths.ts） */
const AIRSHIP = join(ROOT, '.airship')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return {
    app: { getPath: () => p(__dirname, '.tmp', 'settings-home'), getVersion: () => '0.0.0-test' }
  }
})

const { settings } = await import('../main/services/settings')
const { appSettingsFile } = await import('../main/services/paths')

function resetDisk(app: string): void {
  // 只清这个应用自己的那份文件：整棵 AIRSHIP 删掉会连带把 logs/ 端了，
  // 而 ST-004 那条正读同一天的日志——套件偶发红就是这么来的。
  // settings 的内存缓存没法按用例重置，所以每条用例占一个应用、键名也各自独立。
  rmSync(join(AIRSHIP, 'data', app), { recursive: true, force: true })
  mkdirSync(join(AIRSHIP, 'data'), { recursive: true })
}

function fileOf(app: string): string {
  return appSettingsFile(app)
}

describe('每应用一份设置，runtime 自己不持有', () => {
  it('ST-001 应用之间看不到彼此的设置，磁盘上是两份文件', () => {
    // 这条要断言"pdf 那份文件不存在"，所以先把两边都清干净，别留上一轮的
    resetDisk('airship-ffmpeg')
    resetDisk('airship-s3')
    settings.set('airship-ffmpeg', 'prefs', { crf: 20 })
    expect(settings.get('airship-s3', 'prefs', null)).toBeNull()
    expect(settings.get('airship-ffmpeg', 'prefs', null)).toEqual({ crf: 20 })

    expect(existsSync(fileOf('airship-ffmpeg'))).toBe(true)
    expect(existsSync(fileOf('airship-s3'))).toBe(false)
    expect(join(fileOf('airship-ffmpeg')).replace(/\\/g, '/')).toMatch(/\.airship\/data\/airship-ffmpeg\/settings\.json$/)
    // runtime 自己没有设置文件：家的根上不许出现 settings.json
    expect(existsSync(join(AIRSHIP, 'settings.json'))).toBe(false)
  })

  it('ST-002 写 undefined 等于删掉这个键', () => {
    settings.set('airship-ffmpeg', 'temp', '留着')
    settings.set('airship-ffmpeg', 'temp', undefined)
    expect(settings.get('airship-ffmpeg', 'temp', '回落值')).toBe('回落值')
    const stored = JSON.parse(readFileSync(fileOf('airship-ffmpeg'), 'utf8')) as Record<string, unknown>
    expect('temp' in stored).toBe(false)
  })
})

describe('落盘是"临时文件 + 改名"', () => {
  it('ST-003 写完只剩正式文件，内容是完整 JSON', () => {
    resetDisk('airship-reader')
    settings.set('airship-reader', 'prefs', { fontScale: 1.2 })
    expect(existsSync(`${fileOf('airship-reader')}.tmp`)).toBe(false)
    const text = readFileSync(fileOf('airship-reader'), 'utf8')
    expect(JSON.parse(text)).toEqual({ prefs: { fontScale: 1.2 } })
    expect(text).toContain('\n  "prefs"')
  })
})

describe('坏文件不致命', () => {
  it('ST-004 解析失败就改名留证、记日志、从空开始', () => {
    resetDisk('airship-dago')
    mkdirSync(join(AIRSHIP, 'data', 'airship-dago'), { recursive: true })
    writeFileSync(fileOf('airship-dago'), '{ 残缺', 'utf8')

    expect(settings.get('airship-dago', 'anything', '回落')).toBe('回落')
    expect(existsSync(fileOf('airship-dago'))).toBe(false)
    expect(existsSync(`${fileOf('airship-dago')}.bad`)).toBe(true)

    const day = new Date()
    const logFile = join(AIRSHIP, 'logs', `airship-${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}.log`)
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    expect(log).toContain('设置文件解析失败，已重置')
  })

  it('ST-005 顶层是数组时同样从空开始', () => {
    resetDisk('airship-s3')
    mkdirSync(join(AIRSHIP, 'data', 'airship-s3'), { recursive: true })
    writeFileSync(fileOf('airship-s3'), '[1,2,3]', 'utf8')
    expect(settings.get('airship-s3', 'k', '回落')).toBe('回落')
    expect(settings.dump('airship-s3')).toEqual({})
  })
})

describe('连续写与副本', () => {
  it('ST-006 连着写两笔，最后一份文件里两笔都在', () => {
    resetDisk('airship-ffmpeg')
    settings.set('airship-ffmpeg', 'a', 1)
    settings.set('airship-ffmpeg', 'b', 2)
    const stored = JSON.parse(readFileSync(fileOf('airship-ffmpeg'), 'utf8')) as Record<string, unknown>
    expect({ a: stored['a'], b: stored['b'] }).toEqual({ a: 1, b: 2 })
  })

  it('ST-007 一次拿全是副本，改它不影响主进程里那份', () => {
    resetDisk('airship-ffmpeg')
    settings.set('airship-ffmpeg', 'keep', '原值')
    const dump = settings.dump('airship-ffmpeg')
    dump['keep'] = '被外面改了'
    expect(settings.get('airship-ffmpeg', 'keep', '?')).toBe('原值')
  })

  /**
   * ST-008：注册之后第一次读写就能落进自己的目录。
   *
   * 这条钉的是 paths.ts 不许再把"当前有哪些应用"缓存成一张启动时的快照——
   * 第二实例转发包进来时注册表变了，那张缓存不会跟着变，于是新注册的应用一读写就撞
   * undefined (reading 'data')（2026-11-07 真机撞过，每个应用都中招）。
   * 这里故意用一个注册表从来没见过的 id：老实现拿不到目录，新实现当场建出来。
   */
  it('ST-008 runtime 跑起来之后才注册的包，第一次读写就有自己的目录', async () => {
    const late = 'late-installed'
    resetDisk(late)
    const { paths, appDataDir, appCacheDir, appSettingsFile } = await import('../main/services/paths')
    // 先把缓存打出来：这一步模拟"runtime 刚启动、还不知道有这个应用"的那一刻
    const before = paths()

    const data = appDataDir(late)
    expect(data).toBe(join(before.root, 'data', late))
    expect(existsSync(data), '目录要当场建出来').toBe(true)
    expect(existsSync(appCacheDir(late)), 'cache 同理').toBe(true)

    settings.set(late, 'first', '装好之后写的第一笔')
    expect(settings.get(late, 'first', '?')).toBe('装好之后写的第一笔')
    expect(existsSync(appSettingsFile(late)), '设置文件落在它自己那份上').toBe(true)
    // 第二次拿同一个 id 还是同一条路径：现算不等于每次换地方
    expect(appDataDir(late)).toBe(data)
  })
})
