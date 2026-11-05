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

function resetDisk(): void {
  // settings 有内存缓存，先把内存清掉：模块缓存靠重新 import 做不到，所以每个用例用各自己的键名与应用
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
}

function fileOf(app: string): string {
  return app === 'shell' ? shellSettingsFile() : appSettingsFile(app)
}

describe('每应用一份设置，壳自己一份', () => {
  it('ST-001 应用之间看不到彼此的设置，磁盘上是两份文件', () => {
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
    resetDisk()
    settings.set('books', 'prefs', { fontScale: 1.2 })
    expect(existsSync(`${fileOf('books')}.tmp`)).toBe(false)
    const text = readFileSync(fileOf('books'), 'utf8')
    expect(JSON.parse(text)).toEqual({ prefs: { fontScale: 1.2 } })
    expect(text).toContain('\n  "prefs"')
  })
})

describe('坏文件不致命', () => {
  it('ST-004 解析失败就改名留证、记日志、从空开始', () => {
    resetDisk()
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
    resetDisk()
    mkdirSync(join(ROOT, 'apps', 'pdf'), { recursive: true })
    writeFileSync(fileOf('pdf'), '[1,2,3]', 'utf8')
    expect(settings.get('pdf', 'k', '回落')).toBe('回落')
    expect(settings.dump('pdf')).toEqual({})
  })
})

describe('连续写与副本', () => {
  it('ST-006 连着写两笔，最后一份文件里两笔都在', () => {
    resetDisk()
    settings.set('vcp', 'a', 1)
    settings.set('vcp', 'b', 2)
    const stored = JSON.parse(readFileSync(fileOf('vcp'), 'utf8')) as Record<string, unknown>
    expect({ a: stored['a'], b: stored['b'] }).toEqual({ a: 1, b: 2 })
  })

  it('ST-007 一次拿全是副本，改它不影响壳里那份', () => {
    resetDisk()
    settings.set('vcp', 'keep', '原值')
    const dump = settings.dump('vcp')
    dump['keep'] = '被外面改了'
    expect(settings.get('vcp', 'keep', '?')).toBe('原值')
  })
})
