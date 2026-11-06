// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  askConfirm,
  commands,
  imagesNdjson,
  imagesUntagged,
  listEmpty,
  makeFake,
  mountWsld,
  ndjson,
  pullNew,
  pullUpToDate,
  rows,
  tap,
  twoTags,
  unmountAll
} from './support'
import type { FakeAirship, StartCall, StreamCtl } from '@tests/helpers/fakeAirship'
import type { Mount } from '@tests/helpers/mount'
import type { ProcResult } from '@shared/protocol'

/**
 * IM-001 ~ IM-039：镜像页那一列，与拉取 / 删除 / 强制删除。
 *
 * 删除与拉取走流式任务，"正在进行"这一段由用例扣住；
 * 命令行一律看 `fake.procCalls` 里真实发出去的那几条。
 */

const BUSY = 'docker.1ms.run/library/busybox:latest'
const FREE = 'docker.1ms.run/library/hello-world:latest'
const UNTAGGED_ID = 'deadbeef1234'

/** 被占用拒绝那句真 stderr（形态见 wslc 3.0.1 的实测记录） */
const CONFLICT = [
  `conflict: unable to remove repository reference "${BUSY}" (must force) - container f47fdddf9219 is using its referenced image aaef90e06523`,
  '错误代码： ERROR_SHARING_VIOLATION',
  '如果此错误是意外错误，请考虑搜索现有问题或在 https://github.com/microsoft/WSL/issues 提交新问题。'
].join('\n')

const NOT_FOUND = [
  `未找到镜像 '${FREE}'。`,
  '错误代码： WSLC_E_IMAGE_NOT_FOUND',
  '如果此错误是意外错误，请考虑搜索现有问题或在 https://github.com/microsoft/WSL/issues 提交新问题。'
].join('\n')

interface Held {
  call: StartCall
  ctl: StreamCtl
}

function stage(setup: { images?: () => Partial<ProcResult>; list?: string } = {}) {
  const held: Held[] = []
  const fake = makeFake({
    run: (_exe, args) => {
      if (args[0] === 'images') return setup.images?.() ?? { stdout: imagesNdjson() }
      return { stdout: setup.list ?? listEmpty() }
    },
    start: (call, ctl) => {
      held.push({ call, ctl })
    }
  })
  return { fake, held }
}

/** 打开应用并停在「镜像」页 */
async function openImages(fake: FakeAirship): Promise<Mount> {
  const m = await mountWsld(fake)
  await m.settle()
  await m.press('镜像')
  await m.settle()
  return m
}

const imageLines = (m: Mount): string[] =>
  Array.from(m.container.querySelectorAll('.wsld__image')).map((el) => el.textContent ?? '')

const lineOf = (m: Mount, name: string): string =>
  imageLines(m).find((text) => text.includes(name)) ?? ''

const removeBtn = (m: Mount, reference: string): HTMLButtonElement => {
  const el = m.field(`镜像-删除-${reference}`)
  if (!el) throw new Error(`界面上没有「${reference}」那一行的删除键`)
  return el as HTMLButtonElement
}

const pullBox = (m: Mount): HTMLElement => {
  const el = m.field('镜像-拉取框')
  if (!el) throw new Error('界面上找不到拉取框')
  return el
}

const errorBar = (m: Mount): string => m.container.querySelector('.wsld__bar--error')?.textContent ?? ''
const okBar = (m: Mount): string => m.container.querySelector('.wsld__bar--ok')?.textContent ?? ''
const imagesCalls = (fake: FakeAirship): string[] =>
  commands(fake).filter((line) => line.includes('images --format json'))

// 每条用例都从干净的界面开始：失败的用例不会把带重复标识的残骸留给下一条
afterEach(() => {
  unmountAll()
})

describe('摆出来的就是本机有的镜像', () => {
  it('IM-001 停在镜像页就自动加载一次，只发那一条命令', async () => {
    const { fake } = stage()
    const m = await openImages(fake)

    expect(commands(fake)).toEqual(['wslc list -a --format json', 'wslc images --format json'])
    expect(imageLines(m)).toHaveLength(2)
    expect(m.text()).toContain(BUSY)
    expect(m.text()).toContain(FREE)
    m.unmount()
  })

  it('IM-002 一行报的只有这几样', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    const line = lineOf(m, BUSY)

    expect(line).toContain(BUSY)
    expect(line).toContain('4.45MB')
    expect(line).toContain('被 2 个容器引用')
    expect(line).toMatch(/ID aaef90e06523 · 创建 \d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    expect(line).not.toContain('GMT+8')
    m.unmount()
  })

  it('IM-003 引用数写成字符串还是写成数字都读得出', async () => {
    const [busy] = rows(imagesNdjson())
    const { fake } = stage({
      images: () => ({
        stdout: ndjson([{ ...busy!, Containers: '2' }, { ...busy!, ID: 'cc1122334455', Tag: 'other', Containers: 2 }])
      })
    })
    const m = await openImages(fake)

    expect(imageLines(m).filter((text) => text.includes('被 2 个容器引用'))).toHaveLength(2)
    m.unmount()
  })

  it('IM-004 引用数读不成数字时按没人用说', async () => {
    const [busy] = rows(imagesNdjson())
    const asText = { ...busy!, Repository: 'docker.1ms.run/library/redis', Containers: 'N/A' }
    const asEmpty = { ...busy!, Repository: 'docker.1ms.run/library/redis', Tag: '7', Containers: '' }
    const noField = { ...busy!, Repository: 'docker.1ms.run/library/redis' }
    delete (noField as Record<string, unknown>)['Containers']

    const cases: Array<[string, Record<string, unknown>]> = [
      ['N/A', asText],
      ['空串', asEmpty],
      ['没这个字段', noField]
    ]
    for (const [label, row] of cases) {
      const one = stage({ images: () => ({ stdout: ndjson([row]) }) })
      const m = await openImages(one.fake)
      expect(lineOf(m, 'docker.1ms.run/library/redis'), `引用数写成${label}时`).toContain('未被容器引用')
      expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
      m.unmount()
    }
  })

  it('IM-005 没有标签的镜像有自己的说法', async () => {
    const { fake } = stage({ images: () => ({ stdout: imagesUntagged() }) })
    const m = await openImages(fake)

    expect(m.text()).toContain('无标签 · deadbeef1234')
    expect(m.text()).not.toContain('<none>')

    const onlyRepo = ndjson([{ ...rows(imagesNdjson())[0]!, Tag: '<none>' }])
    const second = stage({ images: () => ({ stdout: onlyRepo }) })
    const m2 = await openImages(second.fake)
    expect(lineOf(m2, 'docker.1ms.run/library/busybox')).toContain('docker.1ms.run/library/busybox')
    expect(m2.text()).not.toContain('<none>')
    m2.unmount()
    m.unmount()
  })

  it('IM-006 同一镜像的两个标签占两行，不按 ID 合并', async () => {
    const { fake } = stage({ images: () => ({ stdout: twoTags() }) })
    const m = await openImages(fake)

    expect(imageLines(m)).toHaveLength(3)
    expect(m.text()).toContain(`${BUSY}`)
    expect(m.text()).toContain('docker.1ms.run/library/busybox:backup')
    const both = imageLines(m).filter((text) => text.includes('aaef90e06523'))
    expect(both).toHaveLength(2)
    m.unmount()
  })

  it('IM-037 被引用的排前面，同档内按仓库名再按标签', async () => {
    const { fake } = stage({ images: () => ({ stdout: twoTags() }) })
    const m = await openImages(fake)
    const names = Array.from(m.container.querySelectorAll('.wsld__image-name')).map(
      (el) => el.textContent ?? ''
    )

    // busybox 被 2 个容器引用，它的两个标签都在 hello-world 前面；同档内 backup 先于 latest
    expect(names).toEqual([
      'docker.1ms.run/library/busybox:backup',
      BUSY,
      'docker.1ms.run/library/hello-world:latest'
    ])
    m.unmount()
  })

  it('IM-030 IM-031 空输出不是错误，排版变了行也还在', async () => {
    const none = stage({ images: () => ({ stdout: '' }) })
    const m = await openImages(none.fake)
    expect(m.text()).toContain('本机还没有镜像')
    expect(errorBar(m)).toBe('')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()

    const pretty = JSON.stringify(rows(imagesNdjson()), null, 2)
    const indented = stage({ images: () => ({ stdout: pretty }) })
    const m2 = await openImages(indented.fake)
    expect(imageLines(m2)).toHaveLength(2)
    expect(lineOf(m2, BUSY)).toContain('4.45MB')
    m2.unmount()

    const array = stage({ images: () => ({ stdout: JSON.stringify(rows(imagesNdjson())) }) })
    const m3 = await openImages(array.fake)
    expect(imageLines(m3)).toHaveLength(2)
    m3.unmount()
  })

  it('IM-032 读不懂的行要说清是哪一行，说的是镜像', async () => {
    const { fake } = stage({ images: () => ({ stdout: `${imagesNdjson().trim()}\n这一行不是 JSON` }) })
    const m = await openImages(fake)

    expect(errorBar(m)).toContain('第 3 行')
    expect(errorBar(m)).toContain('镜像')
    expect(errorBar(m)).toContain('这一行不是 JSON')
    m.unmount()
  })

  it('IM-033 读失败不冲掉已经看见的列表', async () => {
    let reply: Partial<ProcResult> = { stdout: imagesNdjson() }
    const { fake } = stage({
      images: () => reply
    })
    const m = await openImages(fake)
    expect(imageLines(m)).toHaveLength(2)

    reply = { code: 1, stderr: '读不到镜像。' }
    await tap(m, '镜像-刷新')
    expect(imageLines(m)).toHaveLength(2)
    expect(errorBar(m)).toContain('读不到镜像。')

    reply = { stdout: imagesNdjson() }
    await tap(m, '镜像-刷新')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    m.unmount()
  })

  it('IM-034 刷新没读完不叠加下一次', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    const btn = m.field('镜像-刷新')
    expect(btn).not.toBeNull()

    await act(async () => {
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      btn!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await m.settle()

    expect(imagesCalls(fake)).toHaveLength(2) // 进来一次 + 这一拍里只算一次
    expect(imageLines(m)).toHaveLength(2)
    m.unmount()
  })
})

describe('找一个镜像不用翻页，汇总说的是全量', () => {
  it('IM-035 IM-038 输入即过滤且不惊动 wslc，汇总还是全量那三个数', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    const before = commands(fake).length

    expect(m.text()).toContain('共 2 个镜像 · 2 个有标签 · 1 个正被容器引用')

    await m.type('搜索仓库名 / 标签 / ID', 'AAEF90')
    expect(imageLines(m)).toHaveLength(1)
    expect(lineOf(m, BUSY)).toContain(BUSY)
    expect(m.text()).toContain('共 2 个镜像 · 2 个有标签 · 1 个正被容器引用')

    await m.type('搜索仓库名 / 标签 / ID', '')
    expect(imageLines(m)).toHaveLength(2)
    expect(commands(fake).length).toBe(before)
    m.unmount()
  })

  it('IM-036 一个都没匹配上', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    await m.type('搜索仓库名 / 标签 / ID', '根本没这个')

    expect(m.text()).toContain('没有匹配的镜像')
    expect(errorBar(m)).toBe('')
    m.unmount()
  })

  it('IM-039 停在页面上不会自己变，那句说明看得见', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    await m.settle(10)

    expect(m.text()).toContain('· 镜像不会自动变化，拉取或删除后会自动更新列表')
    expect(imagesCalls(fake)).toHaveLength(1)
    m.unmount()
  })
})

describe('拉取', () => {
  it('IM-008 IM-010 拉取只发一条 pull <引用>，回车与点键一样', async () => {
    const { fake } = stage()
    const m = await openImages(fake)

    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', `  ${BUSY}  `)
    console.log('IM008 IDS:', Array.from(m.container.querySelectorAll('[id]')).map((e) => e.id).join('|'), 'TEXT:', m.text().slice(0,80))
    await act(async () => {
      pullBox(m).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await m.settle()

    expect(commands(fake)).toEqual([
      'wslc list -a --format json',
      'wslc images --format json',
      `wslc pull ${BUSY}`
    ])
    expect(m.text()).toContain(`正在拉取 ${BUSY}`)
    m.unmount()
  })

  it('IM-009 框里是空的就什么都不发', async () => {
    const { fake } = stage()
    const m = await openImages(fake)

    expect(removeBtn(m, BUSY)).toBeTruthy()
    const box = pullBox(m)
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await m.settle()

    expect(m.text()).toContain('请先输入要拉取的镜像引用，例如 docker.1ms.run/library/redis:7。')
    expect(commands(fake)).toEqual(['wslc list -a --format json', 'wslc images --format json'])
    expect((m.field('镜像-拉取') as HTMLButtonElement).disabled).toBe(true)
    m.unmount()
  })

  it('IM-011 新下载的报"已拉取"，列表只补刷一次', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')
    const before = imagesCalls(fake).length

    held[0]!.ctl.exit({ code: 0, stdout: pullNew() })
    await m.settle()

    expect(okBar(m)).toBe(`已拉取 ${BUSY}`)
    expect(imagesCalls(fake)).toHaveLength(before + 1)
    expect(errorBar(m)).toBe('')
    m.unmount()
  })

  it('IM-012 本来就最新的报"已是最新"，同样只补刷一次', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')
    const before = imagesCalls(fake).length

    held[0]!.ctl.exit({ code: 0, stdout: pullUpToDate() })
    await m.settle()

    expect(okBar(m)).toBe(`${BUSY} 已是最新`)
    expect(okBar(m)).not.toContain('已拉取')
    expect(imagesCalls(fake)).toHaveLength(before + 1)
    m.unmount()
  })

  it('IM-013 没有 Status 行也照样收尾', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')

    held[0]!.ctl.exit({ code: 0, stdout: 'latest: Pulling from library/busybox\n' })
    await m.settle()

    expect(okBar(m)).toBe(`已拉取 ${BUSY}`)
    expect(errorBar(m)).toBe('')
    m.unmount()
  })

  it('IM-014 拉错了能停，停了就是没发生', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')
    const before = imagesCalls(fake).length

    await tap(m, '镜像-取消')
    await m.settle()

    expect(okBar(m)).toBe(`已取消拉取 ${BUSY}`)
    expect(errorBar(m)).toBe('')
    expect(imagesCalls(fake)).toHaveLength(before)
    expect(m.container.querySelector('.wsld__bar--ok')?.textContent).toContain('已取消')
    m.unmount()
  })
})

describe('删除与强制删除', () => {
  it('IM-015 删除前先问一句，没被占用的说清只取消标签', async () => {
    const { fake } = stage()
    const m = await openImages(fake)
    const asked = askConfirm(false)

    await tap(m, `镜像-删除-${FREE}`)
    expect(asked[0]).toContain(`确定要删除镜像引用 ${FREE}？`)
    expect(asked[0]).toContain('如果这个镜像还有其它标签，这一步只会取消当前标签。')
    expect(asked[0]).not.toContain('这样删除会被拒绝')
    expect(commands(fake).filter((line) => line.includes('rmi'))).toEqual([])
    // 问完收回，列表与提示纹丝不动
    expect(imageLines(m)).toHaveLength(2)
    m.unmount()
  })

  it('IM-016 被引用的镜像在问话里就把话说完，按下去仍不带 -f', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    const asked = askConfirm(true)

    await tap(m, `镜像-删除-${BUSY}`)
    expect(asked[0]).toContain('该镜像正被 2 个容器引用，这样删除会被拒绝，届时可再选择强制删除。')
    expect(commands(fake)).toContain(`wslc rmi ${BUSY}`)
    expect(commands(fake)).not.toContain(`wslc rmi -f ${BUSY}`)
    expect(held).toHaveLength(1)
    m.unmount()
  })

  it('IM-017 删干净了怎么说', async () => {
    const both = rows(imagesNdjson())
    let stdout = imagesNdjson()
    const { fake, held } = stage({
      images: () => ({ stdout })
    })
    const m = await openImages(fake)
    const before = imagesCalls(fake).length
    askConfirm(true)

    // 引擎那边已经把它删掉了
    stdout = ndjson(both.filter((row) => row.Repository !== 'docker.1ms.run/library/hello-world'))
    await tap(m, `镜像-删除-${FREE}`)
    held[0]!.ctl.exit({ code: 0 })
    await m.settle()

    expect(okBar(m)).toBe(`已删除 ${FREE}`)
    expect(imagesCalls(fake)).toHaveLength(before + 1)
    expect(imageLines(m)).toHaveLength(1)
    expect(imageLines(m).join(' ')).not.toContain(FREE)
    m.unmount()
  })

  it('IM-018 IM-020 被占用拒绝后那一行换个键，第二次点击才发 -f', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    askConfirm(true)

    await tap(m, `镜像-删除-${BUSY}`)
    held[0]!.ctl.exit({ code: 1, stderr: CONFLICT })
    await m.settle()

    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('强制删除镜像引用（wslc rmi -f）')
    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('强制删除镜像引用（wslc rmi -f）')
    expect(errorBar(m)).toContain('该镜像正被容器使用，再点一次「强制删除」才能把它从磁盘上移除。')
    expect(errorBar(m)).not.toContain('如果此错误是意外错误')

    // 强制删除是第二次显式动作：先问，答"取消"时 wslc 什么都没收到
    const asked = askConfirm(false)
    await tap(m, `镜像-删除-${BUSY}`)
    expect(asked[0]).toContain('强制删除镜像')
    expect(asked[0]).toContain('该镜像正被 2 个容器引用，强制删除后这些容器将无法再次启动。')
    expect(commands(fake).filter((line) => line.includes('rmi'))).toEqual([`wslc rmi ${BUSY}`])

    askConfirm(true)
    await tap(m, `镜像-删除-${BUSY}`)
    expect(commands(fake)).toContain(`wslc rmi -f ${BUSY}`)
    expect(held).toHaveLength(2)
    m.unmount()
  })

  it('IM-019 别的失败不给这个选项', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    askConfirm(true)

    await tap(m, `镜像-删除-${BUSY}`)
    held[0]!.ctl.exit({ code: 1, stderr: NOT_FOUND })
    await m.settle()

    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('删除镜像引用（wslc rmi）')
    expect(errorBar(m)).toContain('未找到镜像')
    expect(errorBar(m)).toContain('WSLC_E_IMAGE_NOT_FOUND')
    expect(errorBar(m)).not.toContain('再点一次「强制删除」')
    expect(errorBar(m)).not.toContain('如果此错误是意外错误')
    m.unmount()
  })

  it('IM-021 一次只删一个引用', async () => {
    const three = rows(twoTags())
    let stdout = twoTags()
    const { fake, held } = stage({ images: () => ({ stdout }) })
    const m = await openImages(fake)
    askConfirm(true)

    stdout = ndjson(three.filter((row) => row.Tag !== 'backup'))
    await tap(m, '镜像-删除-docker.1ms.run/library/busybox:backup')
    held[0]!.ctl.exit({ code: 0 })
    await m.settle()

    const sent = commands(fake).filter((line) => line.includes('rmi'))
    expect(sent).toEqual(['wslc rmi docker.1ms.run/library/busybox:backup'])
    expect(imageLines(m).join(' ')).toContain(BUSY)
    expect(imageLines(m).join(' ')).not.toContain('docker.1ms.run/library/busybox:backup')
    m.unmount()
  })

  it('IM-022 无标签镜像删的是它自己', async () => {
    const { fake, held } = stage({ images: () => ({ stdout: imagesUntagged() }) })
    const m = await openImages(fake)
    askConfirm(true)

    await tap(m, `镜像-删除-${UNTAGGED_ID}`)
    expect(commands(fake)).toContain(`wslc rmi ${UNTAGGED_ID}`)
    expect(commands(fake).join(' ')).not.toContain('<none>')
    expect(held).toHaveLength(1)
    m.unmount()
  })

  it('IM-023 IM-024 手动刷新不冲掉强制那一档，占用消失了就收回', async () => {
    const both = rows(imagesNdjson())
    let stdout = imagesNdjson()
    const { fake, held } = stage({ images: () => ({ stdout }) })
    const m = await openImages(fake)
    askConfirm(true)

    await tap(m, `镜像-删除-${BUSY}`)
    held[0]!.ctl.exit({ code: 1, stderr: CONFLICT })
    await m.settle()
    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('强制删除镜像引用（wslc rmi -f）')

    // 它仍被容器引用：刷新前后这颗键都写着"强制删除"
    await tap(m, '镜像-刷新')
    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('强制删除镜像引用（wslc rmi -f）')

    // 容器不再引用它了：破坏性入口收回
    stdout = ndjson(both.map((row) => ({ ...row, Containers: '0' })))
    await tap(m, '镜像-刷新')
    expect(removeBtn(m, BUSY).getAttribute('title')).toBe('删除镜像引用（wslc rmi）')
    expect(errorBar(m)).not.toContain('再点一次「强制删除」')
    m.unmount()
  })
})

describe('同一时刻只有一个动作在跑', () => {
  it('IM-025 IM-026 IM-027 一次动作在飞时全页僵住，收尾后照常', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')

    // 拉取进行中：那颗键换成「取消」，其余动作一律点不动
    expect(m.field('镜像-拉取')).toBeNull()
    expect(m.field('镜像-取消')).not.toBeNull()
    expect(removeBtn(m, BUSY).disabled).toBe(true)
    expect(removeBtn(m, FREE).disabled).toBe(true)
    expect((m.field('镜像-刷新') as HTMLButtonElement).disabled).toBe(true)

    const before = commands(fake).length
    await tap(m, '镜像-刷新')
    await tap(m, `镜像-删除-${FREE}`)
    expect(commands(fake).length).toBe(before)
    expect(imagesCalls(fake)).toHaveLength(1)

    held[0]!.ctl.exit({ code: 0, stdout: pullUpToDate() })
    await m.settle()
    expect((m.field('镜像-刷新') as HTMLButtonElement).disabled).toBe(false)
    expect(m.field('镜像-拉取')).not.toBeNull()
    expect(removeBtn(m, BUSY).disabled).toBe(false)

    await tap(m, '镜像-刷新')
    expect(imagesCalls(fake).length).toBeGreaterThan(1)
    m.unmount()
  })

  it('IM-028 IM-029 开始新动作就清掉旧提示，失败说的是清洗后的一句话', async () => {
    const { fake, held } = stage()
    const m = await openImages(fake)
    askConfirm(true)

    // 先留一条旧的绿色提示
    await m.type('镜像引用，例如 docker.1ms.run/library/redis:7', BUSY)
    await tap(m, '镜像-拉取')
    held[0]!.ctl.exit({ code: 0, stdout: pullUpToDate() })
    await m.settle()
    expect(okBar(m)).toContain('已是最新')

    // 开始下一次：新旧不同屏
    await tap(m, `镜像-删除-${BUSY}`)
    expect(okBar(m)).toBe('')
    expect(errorBar(m)).toBe('')

    held[1]!.ctl.exit({ code: 1, stderr: NOT_FOUND })
    await m.settle()
    expect(errorBar(m)).toContain('未找到镜像')
    expect(errorBar(m)).not.toContain('如果此错误是意外错误')
    expect(okBar(m)).toBe('')
    m.unmount()
  })
})
