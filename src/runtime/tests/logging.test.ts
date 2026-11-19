import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * LG-001 ~ LG-005：日志的行形状与"写不进去不能带崩应用"。
 *
 * 真写磁盘：日志这件事的判据就是文件里那一行长什么样。
 */

const ROOT = join(__dirname, '.tmp', 'logs-userData')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return { app: { getPath: () => p(__dirname, '.tmp', 'logs-userData') } }
})

const { log } = await import('../main/services/logging')
const { logDir } = await import('../main/services/paths')

function todayFile(): string {
  const d = new Date()
  const name = `airship-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`
  return join(logDir(), name)
}

function lastLine(): string {
  const text = readFileSync(todayFile(), 'utf8')
  return text.trimEnd().split(/\r?\n/).pop() ?? ''
}

describe('一天一个文件，行形状固定', () => {
  beforeEach(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(ROOT, { recursive: true })
    // paths() 把目录缓存住了，重新建出来即可
    mkdirSync(join(ROOT, 'logs'), { recursive: true })
  })

  it('LG-001 日志落在按天的文件里，目录不存在时自动建', () => {
    rmSync(join(ROOT, 'logs'), { recursive: true, force: true })
    log.info('shell', '按天落盘')
    expect(existsSync(todayFile())).toBe(true)
    expect(todayFile()).toMatch(/logs[\\/]airship-\d{4}-\d{2}-\d{2}\.log$/)
  })

  it('LG-002 一行是"时间 级别 [来源] 消息 详情"', () => {
    log.info('vcp', '启动子进程', { jobId: 'j1', code: 0 })
    const line = lastLine()
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO\s+\[vcp\] 启动子进程 /)
    expect(line).toContain('"jobId":"j1"')
  })

  it('LG-003 详情里的换行折成 ⏎，超长截断，没法序列化也有交代', () => {
    log.warn('books', '多行详情', '第一行\n第二行')
    const line = lastLine()
    expect(line).toContain('第一行 ⏎ 第二行')
    expect(line.split(/\r?\n/).length).toBe(1)

    log.info('books', '超长详情', '字'.repeat(5000))
    expect(lastLine().length).toBeLessThan(5200)

    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => log.info('books', '没法序列化', cyclic)).not.toThrow()
    expect(lastLine()).toContain('[unserializable detail]')
  })

  it('LG-004 级别决定控制台出口', () => {
    const spy = { log: vi.spyOn(console, 'log').mockImplementation(() => undefined), warn: vi.spyOn(console, 'warn').mockImplementation(() => undefined), error: vi.spyOn(console, 'error').mockImplementation(() => undefined) }
    log.info('shell', '一条 info')
    log.warn('shell', '一条 warn')
    log.error('shell', '一条 error')
    expect(spy.log).toHaveBeenCalled()
    expect(spy.warn).toHaveBeenCalled()
    expect(spy.error).toHaveBeenCalled()
    expect(readFileSync(todayFile(), 'utf8')).toContain('一条 error')
    spy.log.mockRestore()
    spy.warn.mockRestore()
    spy.error.mockRestore()
  })

  it('LG-005 日志写不进去不能把应用带崩', () => {
    const dir = join(ROOT, 'logs')
    rmSync(dir, { recursive: true, force: true })
    writeFileSync(dir, '这是个占位的文件，不是目录', 'utf8')
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(() => log.info('shell', '写不进去的一条')).not.toThrow()
    // 磁盘写不进去，控制台这一份还是要有
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
