// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commands,
  listEmpty,
  listRunning,
  logsNotFound,
  logsPlain,
  logsStamped,
  makeFake,
  mountWsld,
  ndjson,
  rows,
  tap,
  twoContainers,
  unmountAll,
  askConfirm
} from './support'
import type { FakeAirship, StartCall, StreamCtl } from '@tests/helpers/fakeAirship'
import type { Mount } from '@tests/helpers/mount'
import type { ProcResult } from '@shared/protocol'

/**
 * WL-001 ~ WL-028：容器详情的「日志」那一档。
 *
 * 一次性读走 `run` 的应答；实时走流式任务，行是一块一块喂进来的，
 * 什么时候结束、退出码多少，都由用例按下去。
 */

const RUNNING_ID = 'bbbb22222222' // zeta，在跑
const STOPPED_ID = 'aaaa11111111' // alpha，已停

interface Held {
  call: StartCall
  ctl: StreamCtl
}

function stage(setup: { list?: () => string; logs?: () => Partial<ProcResult> } = {}) {
  const held: Held[] = []
  const fake = makeFake({
    run: (_exe, args) => {
      if (args[0] === 'logs') return setup.logs?.() ?? { stdout: logsPlain() }
      return { stdout: setup.list?.() ?? twoContainers() }
    },
    start: (call, ctl) => {
      held.push({ call, ctl })
    }
  })
  return { fake, held }
}

/** 停在某个容器的「日志」这一档 */
async function openLogs(fake: FakeAirship, name = 'zeta'): Promise<Mount> {
  const m = await mountWsld(fake)
  await m.settle()
  await m.press(name)
  await m.press('日志')
  await m.settle()
  return m
}

const logText = (m: Mount): string => m.container.querySelector('.wsld__logs')?.textContent ?? ''
const logFoot = (m: Mount): string => m.container.querySelector('.wsld__logfoot')?.textContent ?? ''
const notice = (m: Mount): string => m.container.querySelector('.wsld__notice')?.textContent ?? ''
const logCalls = (fake: FakeAirship): string[] =>
  commands(fake).filter((line) => line.startsWith('wslc logs') || line.includes(' logs '))

async function check(m: Mount, name: string): Promise<void> {
  const box = m.field(name) as HTMLInputElement | null
  if (!box) throw new Error(`界面上找不到「${name}」这个开关`)
  await act(async () => {
    box.click()
  })
  await m.settle()
}

afterEach(() => {
  unmountAll()
})

describe('两种读法各发各的命令', () => {
  it('WL-001 「查看日志」拼出一条一次性命令', async () => {
    const { fake } = stage()
    const m = await openLogs(fake)

    await check(m, '显示时间戳')
    await m.select('行数', '500')
    await tap(m, '日志-查看')

    expect(logCalls(fake)).toEqual([`wslc logs -t -n 500 ${RUNNING_ID}`])
    m.unmount()
  })

  it('WL-002 选"全部"时不发出 -n', async () => {
    const { fake } = stage()
    const m = await openLogs(fake)

    await m.select('行数', '0')
    await tap(m, '日志-查看')

    expect(logCalls(fake)).toEqual([`wslc logs ${RUNNING_ID}`])
    m.unmount()
  })

  it('WL-003 「实时日志」拼出带起点的跟随命令，且不带 -n', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    const before = Math.floor(Date.now() / 1000)

    await check(m, '显示时间戳')
    await tap(m, '日志-实时')

    expect(held).toHaveLength(1)
    const line = `wslc ${held[0]!.call.args.join(' ')}`
    const since = Number(/--since (\d+)/.exec(line)?.[1])
    expect(line).toMatch(new RegExp(`^wslc logs -f -t --since \\d+ ${RUNNING_ID}$`))
    expect(Number.isFinite(since) && since >= before).toBe(true)
    expect(line).not.toContain('-n')
    m.unmount()
  })

  it('WL-004 没勾时间戳就两条命令都不带 -t', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)

    await tap(m, '日志-查看')
    expect(logCalls(fake)).toEqual([`wslc logs -n 200 ${RUNNING_ID}`])

    await tap(m, '日志-实时')
    const follow = `wslc ${held[0]!.call.args.join(' ')}`
    expect(follow).toMatch(new RegExp(`^wslc logs -f --since \\d+ ${RUNNING_ID}$`))
    expect(follow).not.toContain('-t')
    m.unmount()
  })

  it('WL-005 空容器标识不起进程', async () => {
    const base = rows(listRunning())[0]!
    const noId = ndjson([{ ...base, ID: '' }])
    const { fake } = stage({ list: () => noId })
    const m = await mountWsld(fake)
    await m.settle()
    await m.press('probe1')
    await m.press('日志')
    await m.settle()

    await tap(m, '日志-查看')
    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    expect(notice(m)).toContain('容器标识不能为空。')

    await tap(m, '日志-实时')
    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    m.unmount()
  })

  it('WL-007 行数只能从那几档里选', async () => {
    const { fake } = stage()
    const m = await openLogs(fake)
    const sel = m.field('行数') as HTMLSelectElement

    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual([
      '最近 100 行',
      '最近 200 行',
      '最近 500 行',
      '最近 1000 行',
      '最近 2000 行',
      '全部'
    ])
    expect(sel.value).toBe('200')
    // 那一格里没有能敲数字的地方：整条工具带上只有开关是输入控件
    const freeText = Array.from(m.container.querySelectorAll<HTMLInputElement>('.wsld__logbar input')).filter(
      (input) => input.type !== 'checkbox'
    )
    expect(freeText).toEqual([])
    m.unmount()
  })
})

describe('日志文本进界面', () => {
  it('WL-008 中间空行原样保留，末尾空尾巴不算一行', async () => {
    const { fake } = stage({ logs: () => ({ stdout: '第一行\n\n第三行\n\n' }) })
    const m = await openLogs(fake)

    await tap(m, '日志-查看')
    expect(logText(m)).toBe('第一行\n\n第三行')
    expect(logFoot(m)).toContain('共 3 行')
    m.unmount()
  })

  it('WL-009 超长行截断并留话', async () => {
    const long = 'x'.repeat(5000)
    const { fake } = stage({ logs: () => ({ stdout: `${long}\n短行\n` }) })
    const m = await openLogs(fake)

    await tap(m, '日志-查看')
    const shown = logText(m).split('\n')[0]!
    expect(shown.endsWith('…（本行过长，已截断显示）')).toBe(true)
    expect(shown.length).toBe(4000 + '…（本行过长，已截断显示）'.length)
    expect(logText(m)).toContain('短行')
    m.unmount()
  })

  it('WL-010 WL-011 勾了时间戳才动行首，认不出来就原样站着', async () => {
    const { fake } = stage({ logs: () => ({ stdout: logsStamped() }) })
    const m = await openLogs(fake)
    await check(m, '显示时间戳')

    await tap(m, '日志-查看')
    const first = logText(m).split('\n')[0]!
    expect(first).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} log line 741 at 1791805726$/)
    expect(first).not.toContain('2026-10-12T')
    m.unmount()

    const plain = stage({ logs: () => ({ stdout: logsPlain() }) })
    const m2 = await openLogs(plain.fake)
    await check(m2, '显示时间戳')
    await tap(m2, '日志-查看')
    // 行首不是时间戳：一个字都不改
    expect(logText(m2).split('\n')[0]).toBe('log line 741 at 1791805726')
    m2.unmount()
  })

  it('WL-015 空输出读得到那句"没有输出"，不挂错误条', async () => {
    const { fake } = stage({ logs: () => ({ code: 0, stdout: '' }) })
    const m = await openLogs(fake)

    await tap(m, '日志-查看')
    expect(notice(m)).toContain('这个容器目前没有任何输出。')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })

  it('WL-016 读失败给的是人话，日志文本区不被污染', async () => {
    let reply: () => Partial<ProcResult> = () => ({ stdout: '先读到的两行\n第二行\n' })
    const { fake } = stage({ logs: () => reply() })
    const m = await openLogs(fake)
    await tap(m, '日志-查看')
    expect(logText(m)).toContain('先读到的两行')

    reply = () => ({ code: 1, stderr: logsNotFound() })
    await tap(m, '日志-查看')
    expect(notice(m)).toContain('找不到容器')
    expect(notice(m)).toContain('WSLC_E_CONTAINER_NOT_FOUND')
    expect(notice(m)).not.toContain('如果此错误是意外错误')
    // 错误文本没被当成日志行贴进去，文本区还是失败前那两行
    expect(logText(m)).toBe('先读到的两行\n第二行')
    m.unmount()
  })
})

describe('实时逐行到屏', () => {
  it('WL-012 WL-013 一条一条长出来，那半行不占位', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')
    const ctl = held[0]!.ctl

    ctl.chunk('stdout', 'line1\nline2\nline3-par')
    await m.settle()
    expect(logText(m)).toBe('line1\nline2')
    expect(logFoot(m)).toContain('共 2 行')
    expect(logFoot(m)).toMatch(/最近加载 \d{2}:\d{2}:\d{2}/)

    ctl.chunk('stdout', 'tial\nline4\n')
    await m.settle()
    expect(logText(m)).toBe('line1\nline2\nline3-partial\nline4')
    expect(logFoot(m)).toContain('共 4 行')
    m.unmount()
  })

  it('WL-014 超过两千行就丢最早的，并说清丢了几个', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')

    const many = Array.from({ length: 2001 }, (_unused, i) => `第 ${i + 1} 行`).join('\n')
    held[0]!.ctl.chunk('stdout', `${many}\n`)
    await m.settle()

    expect(logFoot(m)).toContain('共 2000 行')
    expect(logFoot(m)).toContain('已丢弃最早的 1 行')
    expect(logText(m)).not.toContain('第 1 行')
    expect(logText(m)).toContain('第 2001 行')
    m.unmount()
  })

  it('WL-017 读进行中日志入口全体僵住，不会再起第二条 logs', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')

    expect((m.field('日志-查看') as HTMLButtonElement).disabled).toBe(true)
    expect((m.field('日志-实时') as HTMLButtonElement).disabled).toBe(true)
    expect((m.field('行数') as HTMLSelectElement).disabled).toBe(true)
    expect((m.field('显示时间戳') as HTMLInputElement).disabled).toBe(true)
    expect(m.container.querySelector('.wsld__logbar .spinner')).not.toBeNull()

    const before = commands(fake).length
    await tap(m, '日志-查看')
    await tap(m, '日志-实时')
    expect(commands(fake).length).toBe(before)
    expect(held).toHaveLength(1)

    held[0]!.ctl.exit({ code: 0 })
    await m.settle()
    expect((m.field('日志-查看') as HTMLButtonElement).disabled).toBe(false)
    m.unmount()
  })

  it('WL-021 「停止实时」只停不收摊', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '已经看见的一行\n还有一行\n')
    await m.settle()

    await tap(m, '日志-停止实时')
    await m.settle()

    expect(notice(m)).toContain('已停止实时日志。')
    expect(logText(m)).toBe('已经看见的一行\n还有一行')
    expect(held).toHaveLength(1)
    m.unmount()
  })

  it('WL-020 开实时之前先把屏幕擦净', async () => {
    const { fake, held } = stage({ logs: () => ({ stdout: '旧的历史一\n旧的历史二\n' }) })
    const m = await openLogs(fake)

    await tap(m, '日志-查看')
    expect(logText(m)).toContain('旧的历史一')

    await tap(m, '日志-实时')
    expect(logText(m)).toBe('')
    expect(logFoot(m)).toContain('共 0 行')

    held[0]!.ctl.chunk('stdout', '新的这一行\n')
    await m.settle()
    expect(logText(m)).toBe('新的这一行')
    m.unmount()
  })
})

describe('实时收尾怎么说', () => {
  it('WL-022 自然结束 → 说清多半是容器停了', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '容器吐的一行\n')
    await m.settle()

    held[0]!.ctl.exit({ code: 0 })
    await m.settle()
    expect(notice(m)).toContain('实时日志已结束（容器多半已停止）。')
    expect(logText(m)).toBe('容器吐的一行')
    m.unmount()
  })

  it('WL-023 全程一行都没来', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')

    held[0]!.ctl.exit({ code: 0 })
    await m.settle()
    expect(notice(m)).toContain('实时日志已结束，期间没有新日志。')
    m.unmount()
  })

  it('WL-024 实时里读出失败', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')

    held[0]!.ctl.exit({ code: 1, stderr: logsNotFound() })
    await m.settle()
    expect(notice(m)).toContain('找不到容器')
    expect(notice(m)).toContain('WSLC_E_CONTAINER_NOT_FOUND')
    expect(notice(m)).not.toContain('多半已停止')
    m.unmount()
  })
})

describe('只有运行中的容器可以实时，会话各归各', () => {
  it('WL-018 停止的容器开不了实时，但翻得了旧账', async () => {
    const { fake } = stage()
    const m = await openLogs(fake, 'alpha')

    expect((m.field('日志-实时') as HTMLButtonElement).disabled).toBe(true)
    expect(m.field('日志-实时')?.getAttribute('title')).toContain(
      '容器没在运行，看不了实时日志；要翻旧日志请用「查看日志」。'
    )

    await tap(m, '日志-查看')
    expect(logText(m)).toContain('log line 741')
    expect(commands(fake)).toEqual([
      'wslc list -a --format json',
      `wslc logs -n 200 ${STOPPED_ID}`
    ])
    m.unmount()
  })

  it('WL-019 运行状态一变，能不能实时跟着变，正在跑的实时就地收尾', async () => {
    let list = twoContainers()
    const running = rows(twoContainers())
    const held: Held[] = []
    const fake = makeFake({
      run: (_exe, args) => (args[0] === 'logs' ? { stdout: '' } : { stdout: list }),
      start: (call, ctl) => {
        held.push({ call, ctl })
      }
    })
    const m = await mountWsld(fake)
    await m.settle()
    await m.press('zeta')
    await m.press('日志')
    await m.settle()
    askConfirm(true)

    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '实时收到的一行\n')
    await m.settle()
    expect((m.field('日志-实时') as HTMLButtonElement).classList.contains('btn--primary')).toBe(true)

    // 一次停止动作做完，读回来的列表说它已经停了
    list = ndjson(running.map((row) => ({ ...row, State: 'exited' })))
    await tap(m, '详情-停止')
    held[1]!.ctl.exit({ code: 0 })
    await m.settle()

    expect((m.field('日志-实时') as HTMLButtonElement).disabled).toBe(true)
    expect(m.field('日志-实时')?.getAttribute('title')).toContain('容器没在运行')
    expect(notice(m)).toContain('已停止实时日志。')
    expect(logText(m)).toContain('实时收到的一行')
    m.unmount()
  })

  it('WL-025 换容器 = 旧会话立刻收摊', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '旧容器的一行\n')
    await m.settle()

    await m.press('alpha')
    await m.settle()

    expect(logText(m)).toBe('')
    expect(logFoot(m)).toContain('共 0 行')
    expect((m.field('日志-实时') as HTMLButtonElement).disabled).toBe(true)
    // 旧实时被终止：又一次实时读发的是新容器的标识，而它已经停了，所以进程一个都不起
    await tap(m, '日志-实时')
    expect(held).toHaveLength(1)
    m.unmount()
  })

  it('WL-026 切回「详情」只停实时不清屏', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '切走之前的一行\n')
    await m.settle()

    await m.press('详情')
    await m.settle()
    expect(held).toHaveLength(1)
    expect(commands(fake).filter((line) => line.includes(' logs '))).toHaveLength(1)

    await m.press('日志')
    await m.settle()
    expect(logText(m)).toBe('切走之前的一行')
    expect(commands(fake).filter((line) => line.includes(' logs '))).toHaveLength(1)
    m.unmount()
  })

  it('WL-027 WL-028 自动滚到底默认开着；关掉不挡新行', async () => {
    const { fake, held } = stage()
    const m = await openLogs(fake)
    expect((m.field('自动滚到底') as HTMLInputElement).checked).toBe(true)

    await check(m, '自动滚到底')
    await tap(m, '日志-实时')
    held[0]!.ctl.chunk('stdout', '关掉自动滚之后来的行\n')
    await m.settle()

    expect(logText(m)).toContain('关掉自动滚之后来的行')
    expect(logFoot(m)).toContain('共 1 行')
    m.unmount()
  })

  it('一次性读用真样本：六行都在，顺序不变', async () => {
    const { fake } = stage({ logs: () => ({ stdout: logsStamped() }) })
    const m = await openLogs(fake)
    await tap(m, '日志-查看')

    expect(logText(m).split('\n')).toHaveLength(6)
    expect(logText(m).split('\n')[5]).toContain('log line 746 at 1791805731')
    m.unmount()
  })

  it('一台容器都没有时，日志这一侧不出现', async () => {
    const { fake } = stage({ list: () => listEmpty() })
    const m = await mountWsld(fake)
    await m.settle()

    expect(m.field('日志-查看')).toBeNull()
    expect(m.field('日志-实时')).toBeNull()
    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    m.unmount()
  })
})
