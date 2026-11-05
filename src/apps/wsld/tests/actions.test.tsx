// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  askConfirm,
  commands,
  makeFake,
  mountWsld,
  ndjson,
  rows,
  tap,
  twoContainers,
  unmountAll
} from './support'
import type { FakeAirship, StartCall, StreamCtl } from '@tests/helpers/fakeAirship'
import type { Mount } from '@tests/helpers/mount'

/**
 * CA-001 ~ CA-024：容器的那四个动作。
 *
 * 四个动作走流式任务，所以"正在进行"这一段用例说了算：
 * 替身把 ctl 交出来，什么时候结束、退出码多少，都由用例按下去。
 */

const RUNNING_ID = 'bbbb22222222' // zeta，在跑
const STOPPED_ID = 'aaaa11111111' // alpha，已停

/** 被扣住没放的流式任务 */
interface Held {
  call: StartCall
  ctl: StreamCtl
}

function stage(stdout = twoContainers()): { fake: FakeAirship; held: Held[] } {
  const held: Held[] = []
  const fake = makeFake({
    run: (_exe, args) => (args[0] === 'list' ? { stdout } : {}),
    start: (call, ctl) => {
      held.push({ call, ctl })
    }
  })
  return { fake, held }
}

async function open(fake: FakeAirship, name = 'zeta'): Promise<Mount> {
  const m = await mountWsld(fake)
  await m.settle()
  await m.press(name)
  return m
}

const isDisabled = (m: Mount, name: string): boolean => {
  const el = m.field(name)
  if (!el) throw new Error(`界面上找不到「${name}」`)
  return (el as HTMLButtonElement).disabled === true
}

const REFUSED = [
  `无法删除容器 '${RUNNING_ID}'：容器正在运行。`,
  '错误代码： WSLC_E_CONTAINER_IS_RUNNING',
  '如果此错误是意外错误，请考虑搜索现有问题或在 https://github.com/microsoft/WSL/issues 提交新问题。'
].join('\n')

// 每条用例都从干净的界面开始：失败的用例不会把残骸留给下一条
afterEach(() => {
  unmountAll()
})

describe('四颗键与 wslc 子命令一一对应', () => {
  it('CA-001 启动只发一条 start <ID>，不问一句', async () => {
    const { fake, held } = stage()
    const m = await open(fake, 'alpha')
    const asked = askConfirm(true)

    await tap(m, `行-启动-${STOPPED_ID}`)
    expect(commands(fake).filter((line) => !line.includes('list -a'))).toEqual([`wslc start ${STOPPED_ID}`])
    expect(held).toHaveLength(1)
    // 启动不打断任何东西，所以不弹确认
    expect(asked).toEqual([])
    m.unmount()
  })

  it('CA-002 CA-020 停止只发一条 stop <ID>，按下之前先问一句', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    const asked = askConfirm(true)

    await tap(m, '详情-停止')
    expect(commands(fake).filter((line) => !line.includes('list -a'))).toEqual([`wslc stop ${RUNNING_ID}`])
    expect(held).toHaveLength(1)
    expect(asked[0]).toContain(`确定要停止容器 zeta？容器里正在跑的进程会被终止（wslc stop）。`)
    m.unmount()
  })

  it('CA-003 CA-021 重启只发一条 restart <ID>，问话里说清进程会中断', async () => {
    const { fake } = stage()
    const m = await open(fake)
    const asked = askConfirm(true)

    await tap(m, '详情-重启')
    expect(commands(fake).filter((line) => !line.includes('list -a'))).toEqual([`wslc restart ${RUNNING_ID}`])
    expect(asked[0]).toContain('确定要重启容器 zeta？重启期间容器里的进程会中断（wslc restart）。')
    m.unmount()
  })

  it('CA-004 CA-018 删除已停止的容器发 remove <ID>，问话里只有那一句', async () => {
    const { fake } = stage()
    const m = await open(fake, 'alpha')
    const asked = askConfirm(true)

    await tap(m, '详情-删除')
    expect(commands(fake).filter((line) => !line.includes('list -a'))).toEqual([`wslc remove ${STOPPED_ID}`])
    expect(asked[0]).toContain('确定要删除容器 alpha？此操作不可恢复。')
    expect(asked[0]).not.toContain('将强制停止并删除')
    m.unmount()
  })

  it('CA-005 CA-019 删除运行中的容器发 remove -f <ID>，问话里多一句', async () => {
    const { fake } = stage()
    const m = await open(fake)
    const asked = askConfirm(true)

    await tap(m, '详情-删除')
    expect(commands(fake).filter((line) => !line.includes('list -a'))).toEqual([`wslc remove -f ${RUNNING_ID}`])
    expect(asked[0]).toContain('该容器正在运行，将强制停止并删除（wslc remove -f）。')
    m.unmount()
  })

  it('CA-006 认 ID 不认名称：没有名称的行也照样能操作', async () => {
    const base = rows(twoContainers())[1]!
    const nameless = ndjson([{ ...base, Names: '' }])
    const fake = makeFake({ run: () => ({ stdout: nameless }) })
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)

    // 行上只剩 ID 可认
    expect(m.has(STOPPED_ID)).toBe(true)
    await m.press(STOPPED_ID)
    await tap(m, '详情-重启')

    const sent = commands(fake).filter((line) => !line.includes('list -a'))
    expect(sent).toEqual([`wslc restart ${STOPPED_ID}`])
    m.unmount()
  })

  it('CA-007 空 ID 连进程都不起，界面停在原地', async () => {
    const base = rows(twoContainers())[1]!
    const noId = ndjson([{ ...base, ID: '', Names: '没标识' }])
    const fake = makeFake({ run: () => ({ stdout: noId }) })
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)
    await m.press('没标识')

    await tap(m, '详情-启动')
    // 一条命令都没发（只有开局那次读）
    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    expect(m.text()).toContain('容器 ID 不能为空。')
    expect(m.container.querySelector('.wsld__title')?.textContent).toBe('没标识')
    m.unmount()
  })
})

describe('全局一次只有一个动作在飞', () => {
  it('CA-008 操作进行中所有操作键与刷新都按不动，那一行转圈', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    askConfirm(true)

    await tap(m, '详情-停止')
    expect(held).toHaveLength(1)

    for (const name of ['详情-启动', '详情-停止', '详情-重启', '详情-删除', '容器-刷新', `行-启动-${STOPPED_ID}`]) {
      expect(isDisabled(m, name), `「${name}」该是按不动的`).toBe(true)
    }
    // 发起操作的那一行同时转起忙碌圈
    expect(m.container.querySelector('.wsld__row .spinner')).not.toBeNull()
    m.unmount()
  })

  it('CA-009 二次触发被吞掉，wslc 只听见一条命令', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    askConfirm(true)

    await tap(m, '详情-停止')
    const before = commands(fake).length
    await tap(m, '详情-重启')
    await tap(m, '详情-停止')

    expect(commands(fake).length).toBe(before)
    expect(held).toHaveLength(1)
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()

    // 第一个操作结束后按钮统一恢复可用
    held[0]!.ctl.exit({ code: 0 })
    await m.settle()
    expect(isDisabled(m, '详情-重启')).toBe(false)
    m.unmount()
  })

  it('CA-010 操作期间不发出 wslc list，结束后照旧能刷', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    askConfirm(true)

    await tap(m, '详情-停止')
    const before = commands(fake).filter((line) => line.includes('list -a')).length
    await tap(m, '容器-刷新')
    expect(commands(fake).filter((line) => line.includes('list -a')).length).toBe(before)

    held[0]!.ctl.exit({ code: 1, stderr: REFUSED })
    await m.settle()
    await tap(m, '容器-刷新')
    expect(commands(fake).filter((line) => line.includes('list -a')).length).toBe(before + 1)
    m.unmount()
  })
})

describe('成功就刷一次，失败就原地站着', () => {
  it('CA-011 操作成功 → 列表补刷一次，状态跟着变', async () => {
    const running = rows(twoContainers())
    let stdout = ndjson(running)
    const held: Held[] = []
    const fake = makeFake({
      run: () => ({ stdout }),
      start: (_call, ctl) => {
        held.push({ call: _call, ctl })
      }
    })
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)
    await m.press('zeta')

    // 操作做完引擎那边就停下来了：下一次读回来它已停止
    stdout = ndjson(running.map((row) => ({ ...row, State: row.ID === RUNNING_ID ? 'exited' : row.State })))
    const before = commands(fake).filter((line) => line.includes('list -a')).length

    await tap(m, '详情-停止')
    held[0]!.ctl.exit({ code: 0 })
    await m.settle()

    expect(commands(fake).filter((line) => line.includes('list -a')).length).toBe(before + 1)
    expect(m.text()).toContain('共 2 个容器 · 0 个运行中')
    expect(m.container.querySelector('.wsld__badge')?.textContent).toBe('已停止')
    m.unmount()
  })

  it('CA-012 删除成功 → 那一行消失，详情收回', async () => {
    const both = rows(twoContainers())
    let stdout = ndjson(both)
    const held: Held[] = []
    const fake = makeFake({
      run: () => ({ stdout }),
      start: (call, ctl) => {
        held.push({ call, ctl })
      }
    })
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)
    await m.press('alpha')

    stdout = ndjson(both.filter((row) => row.ID !== STOPPED_ID))
    await tap(m, '详情-删除')
    held[0]!.ctl.exit({ code: 0 })
    await m.settle()

    expect(commands(fake)).toContain(`wslc remove ${STOPPED_ID}`)
    expect(m.container.querySelector('.wsld__row-name')?.textContent).toBe('zeta')
    expect(rowNames(m)).toEqual(['zeta'])
    expect(m.container.querySelector('.wsld__detail')?.textContent).toContain('点击左侧的容器查看详情')
    m.unmount()
  })

  it('CA-013 CA-014 操作失败 → 不补刷，错误条说的是引擎拒绝', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    askConfirm(true)
    const before = commands(fake).filter((line) => line.includes('list -a')).length

    await tap(m, '详情-删除')
    held[0]!.ctl.exit({ code: 1, stderr: REFUSED })
    await m.settle()

    expect(commands(fake).filter((line) => line.includes('list -a')).length).toBe(before)
    const bar = m.container.querySelector('.wsld__bar--error')?.textContent ?? ''
    expect(bar).toContain(`无法删除容器 '${RUNNING_ID}'：容器正在运行。`)
    expect(bar).toContain('错误代码： WSLC_E_CONTAINER_IS_RUNNING')
    expect(bar).not.toContain('如果此错误是意外错误')
    // 列表还是上一次成功读回的样子
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])
    m.unmount()
  })
})

describe('按钮可用性只是体验优化', () => {
  it('CA-015 CA-016 CA-017 运行中的按不动启动，已停止的按不动停止，重启与删除永远可按', async () => {
    const { fake } = stage()
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)

    await m.press('zeta')
    expect(isDisabled(m, '详情-启动')).toBe(true)
    expect(isDisabled(m, '详情-停止')).toBe(false)
    expect(isDisabled(m, '详情-重启')).toBe(false)
    expect(isDisabled(m, '详情-删除')).toBe(false)
    // 已停止那行的「启动」仍可按
    expect(isDisabled(m, `行-启动-${STOPPED_ID}`)).toBe(false)

    await m.press('alpha')
    expect(isDisabled(m, '详情-停止')).toBe(true)
    expect(isDisabled(m, '详情-启动')).toBe(false)
    expect(isDisabled(m, '详情-重启')).toBe(false)
    expect(isDisabled(m, '详情-删除')).toBe(false)
    m.unmount()
  })

  it('CA-022 答"取消"什么都不发生', async () => {
    const { fake, held } = stage()
    const m = await open(fake)
    const asked = askConfirm(false)

    await tap(m, '详情-删除')
    expect(asked.length).toBe(1)
    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    expect(held).toHaveLength(0)
    // 选中行与详情都没换过
    expect(m.container.querySelector('.wsld__title')?.textContent).toBe('zeta')
    expect(isDisabled(m, '详情-重启')).toBe(false)
    m.unmount()
  })
})

describe('行是认 ID 续用的，界面只给这四个动作', () => {
  it('CA-023 刷新不重建行：还是同一个界面元素', async () => {
    const { fake } = stage()
    const m = await mountWsld(fake)
    await m.settle()

    const before = m.container.querySelector('.wsld__row')
    expect(before?.textContent).toContain('zeta')

    await tap(m, '容器-刷新')
    const after = m.container.querySelector('.wsld__row')
    expect(after).toBe(before)
    expect(after?.textContent).toContain('zeta')
    m.unmount()
  })

  it('CA-024 找不到强杀，也找不到批量', async () => {
    const { fake } = stage()
    const m = await mountWsld(fake)
    await m.settle()
    askConfirm(true)
    await m.press('zeta')

    const visible = m.text()
    expect(visible).not.toMatch(/kill|强杀/)
    expect(visible).not.toContain('批量')
    // 行上与详情头部都没有勾选框：所有操作都是对一个容器一个一个来
    expect(m.container.querySelectorAll('.wsld__row input[type=checkbox]')).toHaveLength(0)
    expect(m.container.querySelectorAll('.wsld__detail-head input[type=checkbox]')).toHaveLength(0)
    m.unmount()
  })
})

const rowNames = (m: Mount): string[] =>
  Array.from(m.container.querySelectorAll('.wsld__row-name')).map((el) => el.textContent ?? '')

