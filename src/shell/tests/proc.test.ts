import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * PT-001 ~ PT-005：proc 只跑白名单，以及两种用法的可见结果。
 *
 * 跑的是真 proc.ts 与真子进程（node 自己）——"输出分块推回、中文不被劈开"这类事
 * 用替身验就等于验替身。工具表与白名单走 services/tools.ts 的真登记函数。
 */

const ROOT = join(process.cwd(), 'src', 'shell', 'tests', '.tmp', 'proc-userData')

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  return { app: { getPath: () => p(process.cwd(), 'src', 'shell', 'tests', '.tmp', 'proc-userData') } }
})

const { proc, setProcEmitter } = await import('../main/services/proc')
const { allowExecutable, isAllowedExecutable, resetToolDiscovery } = await import('../main/services/tools')

const NODE = process.execPath
/** 一直活着，等被杀 */
const SLEEPER = ['-e', 'setInterval(() => {}, 5000)']
/** 中文重复若干遍：输出跨多个管道块，够把多字节字符劈在块边界上 */
const CJK = '中文字幕测试，缩略图与响度归一。'
const REPEATS = 3000
const CHATTER = ['-e', `for(let i=0;i<${REPEATS};i++)process.stdout.write(${JSON.stringify(CJK)})`]

const events: Array<{ app: string; event: { kind: string; jobId?: string; text?: string; stream?: string; result?: { code: number | null; signal: string | null } } }> = []

function chunksOf(jobId: string): string {
  return events
    .filter((e) => e.event.kind === 'proc:chunk' && e.event.jobId === jobId)
    .map((e) => e.event.text ?? '')
    .join('')
}

function exitsOf(jobId: string) {
  return events.filter((e) => e.event.kind === 'proc:exit' && e.event.jobId === jobId)
}

async function waitUntil(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等子进程等超时了')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
  resetToolDiscovery()
  allowExecutable(NODE)
  events.length = 0
  setProcEmitter((app, event) => events.push({ app, event: event as never }))
})

afterEach(() => {
  proc.killAll()
  resetToolDiscovery()
})

describe('proc 只跑白名单里的可执行文件', () => {
  it('PT-001 白名单外的东西，两条路都拒，原因说清来历', async () => {
    const stranger = join(ROOT, 'notepad.exe')
    expect(isAllowedExecutable(stranger)).toBe(false)

    await expect(proc.run('vcp', { exe: stranger, args: [] })).rejects.toThrowError(
      `不允许执行 ${stranger}：可执行文件必须先由壳发现或用户在设置里指定（见 tools.ts 的白名单规则）`
    )
    expect(() => proc.start('vcp', { exe: stranger, args: [], jobId: 'j' })).toThrowError(/不允许执行/)
    // 拒了就不该有进程被起，也不该有事件回流
    expect(proc.list('vcp')).toEqual([])
    expect(events).toEqual([])
  })
})

describe('两种用法各自的结果', () => {
  it('PT-002 一次性调用把退出码、信号与两路输出完整交回，不推分块事件', async () => {
    const res = await proc.run('vcp', {
      exe: NODE,
      args: ['-e', "console.log('hi');console.error('boo');process.exit(3)"]
    })
    expect(res.code).toBe(3)
    expect(res.signal).toBeNull()
    expect(res.stdout.trim()).toBe('hi')
    expect(res.stderr.trim()).toBe('boo')
    // 一次性调用不该往窗口推 chunk / exit
    expect(events.filter((e) => e.event.kind.startsWith('proc:'))).toEqual([])
  })

  it('PT-003 后台任务的输出分块推回归属窗口，中文不被劈成半字', async () => {
    proc.start('vcp', { exe: NODE, args: CHATTER, jobId: 'flow' })
    await waitUntil(() => exitsOf('flow').length === 1)

    const expectText = CJK.repeat(REPEATS)
    const got = chunksOf('flow')
    expect(got).toBe(expectText)
    // 半字会显形成替换字符 U+FFFD，一个都不许有
    expect(got).not.toContain(String.fromCharCode(0xfffd))
    // 分块确实是一点一点到的，不是一次性一整块
    const parts = events.filter((e) => e.event.kind === 'proc:chunk' && e.event.jobId === 'flow')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((e) => e.app === 'vcp')).toBe(true)

    const exit = exitsOf('flow')[0]!
    expect(exit.event.result).toMatchObject({ code: 0 })
    expect(proc.list('vcp')).not.toContain('flow')
    // 结束事件带回来的 stdout 与分块拼起来一致
    expect(exit.event.result?.stdout).toBe(expectText)
  })

  it('PT-004 同一应用内任务标识重复被拒，别的应用用同一个标识不受影响', () => {
    proc.start('vcp', { exe: NODE, args: SLEEPER, jobId: 'same' })
    expect(() => proc.start('vcp', { exe: NODE, args: SLEEPER, jobId: 'same' })).toThrowError(
      '任务标识重复：same（同一个应用内要唯一）'
    )
    expect(() => proc.start('pdf', { exe: NODE, args: SLEEPER, jobId: 'same' })).not.toThrow()
    expect(proc.list('vcp')).toEqual(['same'])
    expect(proc.list('pdf')).toEqual(['same'])
  })

  it('PT-005 停止任务：在跑的才停得掉，且只回来一条结束事件', async () => {
    proc.start('vcp', { exe: NODE, args: SLEEPER, jobId: 'live' })
    expect(proc.list('vcp')).toContain('live')

    expect(proc.kill('nope', 'vcp')).toBe(false)
    expect(events.filter((e) => e.event.kind === 'proc:exit')).toEqual([])

    expect(proc.kill('live', 'vcp')).toBe(true)
    await waitUntil(() => exitsOf('live').length === 1)
    expect(exitsOf('live')[0]!.event.result).toMatchObject({ signal: 'SIGKILL' })
    expect(proc.list('vcp')).toEqual([])

    // 已经结束的任务再停一次：没有这条任务了，返回 false，也不再产生事件
    expect(proc.kill('live', 'vcp')).toBe(false)
    expect(exitsOf('live').length).toBe(1)
  })
})
