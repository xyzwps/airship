// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commands,
  listEmpty,
  listExited,
  listRunning,
  logsNotFound,
  makeFake,
  mountWsld,
  ndjson,
  rows,
  tap,
  twoContainers,
  unmountAll
} from './support'
import type { Mount } from '@tests/helpers/mount'

/**
 * CL-001 ~ CL-027：容器页那一列容器，与点一行之后右边那块详情。
 *
 * 每一条都真渲染、真点：命令行看 `fake.procCalls`，话看界面文字。
 * 容器与镜像数据一律从 wslc 3.0.1 的真样本改出来（见 tests/fixtures/）。
 */

/** 按 `wslc list -a --format json` 的应答造一个壳 */
async function mountList(stdout: string, extra: { code?: number; stderr?: string } = {}): Promise<Mount> {
  const fake = makeFake({
    run: (_exe, args) =>
      args[0] === 'list' ? { code: extra.code ?? 0, stdout, stderr: extra.stderr ?? '' } : {}
  })
  const m = await mountWsld(fake)
  await m.settle()
  return m
}

const rowNames = (m: Mount): string[] =>
  Array.from(m.container.querySelectorAll('.wsld__row-name')).map((el) => el.textContent ?? '')

const rowOf = (m: Mount, name: string): HTMLElement => {
  const hit = Array.from(m.container.querySelectorAll<HTMLElement>('.wsld__row')).find(
    (el) => (el.querySelector('.wsld__row-name')?.textContent ?? '') === name
  )
  if (!hit) throw new Error(`列表里没有「${name}」这一行`)
  return hit
}

const valueOf = (m: Mount, label: string): string => {
  const key = Array.from(m.container.querySelectorAll<HTMLElement>('dt')).find(
    (el) => el.textContent === label
  )
  if (!key) throw new Error(`详情里读不到「${label}」这一项`)
  return key.nextElementSibling?.textContent ?? ''
}

// 每条用例都从干净的界面开始：失败的用例不会把残骸留给下一条
afterEach(() => {
  unmountAll()
})

describe('打开就把本机容器摆出来', () => {
  it('CL-001 启动应用自动读一次，只发那一条命令', async () => {
    const fake = makeFake({ run: () => ({ stdout: twoContainers() }) })
    const m = await mountWsld(fake)
    await m.settle()

    expect(commands(fake)).toEqual(['wslc list -a --format json'])
    expect(m.text()).toContain('zeta')
    expect(m.text()).toContain('alpha')
    m.unmount()
  })

  it('CL-002 一行只报名称、状态、镜像', async () => {
    const m = await mountList(twoContainers())
    const line = rowOf(m, 'zeta').textContent ?? ''

    expect(line).toContain('zeta')
    expect(line).toContain('运行中')
    expect(line).toContain('docker.1ms.run/library/busybox:latest')
    // 命令、端口、网络、创建时间、ID 一概不进这一行
    expect(line).not.toContain('sleep 3600')
    expect(line).not.toContain('bridge')
    expect(line).not.toContain('2026-10-11')
    expect(line).not.toContain('bbbb22222222')
    m.unmount()
  })

  it('CL-003 运行中的排前面，同档内按名称', async () => {
    const m = await mountList(twoContainers())
    // alpha 按字母序本该在前，只因没在跑，被压到 zeta 后面
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])
    m.unmount()
  })

  it('CL-004 本机一个容器都没有：那句人话，不是错误', async () => {
    const m = await mountList(listEmpty())
    expect(m.text()).toContain('本机还没有容器')
    expect(m.text()).toContain('共 0 个容器 · 0 个运行中')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })

  it('CL-005 汇总报的是全机的数，不跟着搜索词变', async () => {
    const m = await mountList(twoContainers())
    await m.type('搜索名称 / 镜像 / ID', 'zet')

    expect(m.text()).toContain('共 2 个容器 · 1 个运行中')
    expect(rowNames(m)).toEqual(['zeta'])
    m.unmount()
  })

  it('CL-006 最近刷新精确到秒，一次都没成功过时读"尚未刷新"', async () => {
    const ok = await mountList(twoContainers())
    expect(ok.text()).toMatch(/最近刷新 \d{2}:\d{2}:\d{2}/)
    ok.unmount()

    const failed = await mountList('', { code: 1, stderr: logsNotFound() })
    expect(failed.text()).toContain('尚未刷新')
    failed.unmount()
  })
})

describe('列表靠刷新跟上本机变化', () => {
  it('CL-007 点刷新只发那一条命令', async () => {
    const fake = makeFake({ run: () => ({ stdout: twoContainers() }) })
    const m = await mountWsld(fake)
    await m.settle()

    await tap(m, '容器-刷新')
    expect(commands(fake)).toEqual(['wslc list -a --format json', 'wslc list -a --format json'])
    m.unmount()
  })

  it('CL-008 上一次没读回来不叠加下一次', async () => {
    const fake = makeFake({ run: () => ({ stdout: twoContainers() }) })
    const m = await mountWsld(fake)
    await m.settle()

    const btn = m.field('容器-刷新')
    expect(btn).not.toBeNull()
    // 同一拍里连点两下：第一下的读还没回来，第二下该被直接跳过
    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await m.settle()

    expect(commands(fake).filter((line) => line.includes('list -a'))).toHaveLength(2)
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])
    m.unmount()
  })
})

describe('找一个容器不用翻页', () => {
  it('CL-009 CL-010 输入即过滤，全过程不惊动 wslc', async () => {
    const fake = makeFake({ run: () => ({ stdout: twoContainers() }) })
    const m = await mountWsld(fake)
    await m.settle()
    const before = commands(fake).length

    // ID 的中间一段：不要求从头开始，也不区分大小写
    await m.type('搜索名称 / 镜像 / ID', 'BB2')
    expect(rowNames(m)).toEqual(['zeta'])

    await m.type('搜索名称 / 镜像 / ID', 'HELLO-WORLD')
    expect(rowNames(m)).toEqual(['alpha'])

    await m.type('搜索名称 / 镜像 / ID', 'busybox')
    expect(rowNames(m)).toEqual(['zeta'])

    expect(commands(fake).length).toBe(before)
    m.unmount()
  })

  it('CL-011 一个都没匹配上时那句人话', async () => {
    const m = await mountList(twoContainers())
    await m.type('搜索名称 / 镜像 / ID', '根本没有这个')

    expect(m.text()).toContain('没有匹配的容器')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })

  it('CL-012 清空搜索词回到全部，顺序不变', async () => {
    const m = await mountList(twoContainers())
    await m.type('搜索名称 / 镜像 / ID', 'zet')
    expect(rowNames(m)).toEqual(['zeta'])

    await m.type('搜索名称 / 镜像 / ID', '')
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])
    m.unmount()
  })
})

describe('wslc 说什么，界面说人话', () => {
  it('CL-027 这台机器上没有 wslc 时告诉用户怎么办', async () => {
    const fake = makeFake({ wslc: null })
    const m = await mountWsld(fake)
    await m.settle()

    const visible = m.text()
    expect(visible).toContain('这台机器上没有 wslc')
    expect(visible).toContain('WSL 3')
    expect(visible).toContain('完整路径')
    // 页签照常、不崩、不挂半截错误，wslc 那侧一条命令都没收到
    expect(m.has('容器')).toBe(true)
    expect(m.has('镜像')).toBe(true)
    expect(commands(fake)).toEqual([])
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })

  it('CL-022 排版怎么变都读出同样的行', async () => {
    const pretty = await mountList(JSON.stringify(rows(twoContainers()), null, 2))
    expect(rowNames(pretty)).toEqual(['zeta', 'alpha'])
    pretty.unmount()

    const array = await mountList(JSON.stringify(rows(twoContainers())))
    expect(rowNames(array)).toEqual(['zeta', 'alpha'])
    array.unmount()

    const one = await mountList(listRunning())
    expect(rowNames(one)).toEqual(['probe1'])
    one.unmount()

    const singleObject = await mountList(JSON.stringify(rows(listExited())[0]))
    expect(rowNames(singleObject)).toEqual(['probe1'])
    singleObject.unmount()
  })

  it('CL-023 读不懂的行要说清是哪一行，说的是容器', async () => {
    const m = await mountList(`${listRunning().trim()}\n这不是 JSON`)
    const bar = m.container.querySelector('.wsld__bar--error')?.textContent ?? ''

    expect(bar).toContain('第 2 行')
    expect(bar).toContain('容器')
    expect(bar).toContain('这不是 JSON')
    m.unmount()
  })

  it('CL-024 CL-025 错误条丢掉样板话，stderr 是空的也要有话', async () => {
    const withStderr = await mountList('', { code: 1, stderr: logsNotFound() })
    const bar = withStderr.container.querySelector('.wsld__bar--error')?.textContent ?? ''
    expect(bar).toContain('找不到容器')
    expect(bar).toContain('WSLC_E_CONTAINER_NOT_FOUND')
    expect(bar).not.toContain('如果此错误是意外错误')
    withStderr.unmount()

    const silent = await mountList('', { code: 1, stderr: '' })
    expect(silent.container.querySelector('.wsld__bar--error')?.textContent).toContain('wslc 命令执行失败。')
    silent.unmount()
  })

  it('CL-026 读失败不冲掉已经看见的列表', async () => {
    let stdout = twoContainers()
    let code = 0
    const fake = makeFake({
      run: () => ({ code, stdout, stderr: code === 0 ? '' : '引擎没答上话。' })
    })
    const m = await mountWsld(fake)
    await m.settle()
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])

    code = 1
    await tap(m, '容器-刷新')
    expect(m.text()).toContain('引擎没答上话。')
    expect(rowNames(m)).toEqual(['zeta', 'alpha'])

    code = 0
    await tap(m, '容器-刷新')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })
})

describe('点一行就是它的详情', () => {
  it('CL-013 还没选容器时右侧只有一句引导', async () => {
    const m = await mountList(twoContainers())
    const detail = m.container.querySelector('.wsld__detail')?.textContent ?? ''

    expect(detail).toContain('点击左侧的容器查看详情')
    expect(detail).not.toContain('基本信息')
    expect(m.field('详情-启动')).toBeNull()
    m.unmount()
  })

  it('CL-014 点一行就把标题、状态与四颗键摆出来', async () => {
    const m = await mountList(twoContainers())
    await m.press('zeta')

    const head = m.container.querySelector('.wsld__detail-head')?.textContent ?? ''
    expect(head).toContain('zeta')
    expect(head).toContain('运行中')
    for (const name of ['详情-启动', '详情-停止', '详情-重启', '详情-删除']) {
      expect(m.field(name), `详情头部缺「${name}」那颗键`).not.toBeNull()
    }
    m.unmount()
  })

  it('CL-015 换一行，详情立刻跟着换', async () => {
    const m = await mountList(twoContainers())
    await m.press('zeta')
    expect(m.container.querySelector('.wsld__title')?.textContent).toBe('zeta')

    await m.press('alpha')
    expect(m.container.querySelector('.wsld__title')?.textContent).toBe('alpha')
    expect(valueOf(m, '镜像')).toBe('docker.1ms.run/library/hello-world:latest')
    m.unmount()
  })

  it('CL-016 详情分成这几节，基本信息六项都在', async () => {
    const m = await mountList(twoContainers())
    await m.press('zeta')
    const visible = m.text()

    for (const title of ['基本信息', '运行状态', '网络', '标签']) expect(visible).toContain(title)
    expect(valueOf(m, 'ID')).toBe('bbbb22222222')
    expect(valueOf(m, '镜像')).toBe('docker.1ms.run/library/busybox:latest')
    expect(valueOf(m, '命令')).toContain('sleep 3600')
    expect(valueOf(m, '创建时间')).toContain('2026-10-11')
    expect(valueOf(m, '大小')).toBe('0B')
    expect(valueOf(m, '平台')).toBe('linux / amd64')
    expect(valueOf(m, '状态详情')).toContain('Up Less than a second')
    m.unmount()
  })

  it('CL-017 没有值的字段摆成横杠', async () => {
    const m = await mountList(listRunning())
    await m.press('probe1')

    expect(valueOf(m, '端口')).toBe('—')
    expect(valueOf(m, '健康检查')).toBe('—')
    expect(valueOf(m, '网络')).toBe('bridge')
    m.unmount()
  })

  it('CL-018 选中的容器在别处被删掉了', async () => {
    let stdout = twoContainers()
    const fake = makeFake({ run: () => ({ stdout }) })
    const m = await mountWsld(fake)
    await m.settle()
    await m.press('alpha')
    expect(m.container.querySelector('.wsld__title')?.textContent).toBe('alpha')

    // 另一个终端把它删掉了：本应用只是刷了一次列表
    stdout = listRunning()
    await tap(m, '容器-刷新')

    const detail = m.container.querySelector('.wsld__detail')?.textContent ?? ''
    expect(detail).toContain('未找到该容器，可能已被删除。')
    expect(rowNames(m)).toEqual(['probe1'])
    m.unmount()
  })

  it('CL-019 CL-020 一个标签占两行，值里带逗号与括号不算拆行', async () => {
    const base = rows(listRunning())[0]!
    const m = await mountList(ndjson([{ ...base, Labels: 'com.example.a=1,com.example.b=2' }]))
    await m.press('probe1')

    const groups = m.container.querySelectorAll('.wsld__label')
    expect(groups.length).toBe(2)
    expect(groups[0]?.textContent).toBe('com.example.a1')
    expect(groups[1]?.textContent).toBe('com.example.b2')
    m.unmount()

    const nested = await mountList(listRunning())
    await nested.press('probe1')
    const text = nested.container.querySelector('.wsld__labels')?.textContent ?? ''
    // 真样本里那条 metadata 的值自己就带一串花括号与逗号
    expect(text).toContain('"InitProcessFlags":0')
    expect(text).toContain('wslcdtest')
    expect(nested.container.querySelectorAll('.wsld__label').length).toBe(2)
    nested.unmount()
  })

  it('CL-021 一个标签都没有时给横杠', async () => {
    const base = rows(listExited())[0]!
    const m = await mountList(ndjson([{ ...base, Labels: '' }]))
    await m.press('probe1')

    const section = Array.from(m.container.querySelectorAll('section')).find(
      (el) => el.querySelector('.card__title')?.textContent === '标签'
    )
    expect(section?.textContent).toBe('标签—')
    m.unmount()
  })
})
