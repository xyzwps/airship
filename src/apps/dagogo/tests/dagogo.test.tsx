// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { FakeAirship } from '@tests/helpers/fakeAirship'
import { mountUi, type Mount } from '@tests/helpers/mount'
import DagogoApp from '@apps/dagogo/DagogoApp'
import { isToday } from '@apps/dagogo/time'
import { normalizeImportedTasks } from '@apps/dagogo/types'
import { loadTasks } from '@apps/dagogo/storage'
import type { Task } from '@apps/dagogo/types'

/**
 * DG 册子（docs/specs/dagogo.md）。
 *
 * 打勾勾的全部数据都在应用自己的 data 目录里（dagogo.json），导出文件与手机版互读，
 * 托盘徽标与提示文字交给壳——三条都拿 FakeAirship 断言。
 *
 * 托盘那张图是渲染侧用 canvas 画的（jsdom 没有 2D 上下文，图上的字归 `just shot`），
 * 所以只把它换成一张假图，断言仍落在壳收到的 `tray.set` 入参上。
 */

vi.mock('@shell/trayIcon', () => ({
  renderTrayIcon: async (text: string): Promise<string> => `data:image/png;base64,FAKE${text}`
}))

const DATA = '/fake/userData/apps/dagogo/data/dagogo.json'
const CAPS = ['fs.read', 'fs.write', 'dialog', 'settings', 'tray', 'notify', 'log'] as const

function shell(files?: Record<string, string>, picks?: Array<string[] | string | null>): FakeAirship {
  return new FakeAirship({ id: 'dagogo', capabilities: [...CAPS], files, picks })
}

/** 按本地时刻造 ISO 串：换天判的是本地日历日，不是 UTC */
function localIso(dayOffset: number, hour: number, minute = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function seedTasks(tasks: Array<Partial<Task>>): string {
  const full = tasks.map((t) => ({
    id: t.id ?? 'x',
    title: t.title ?? '',
    createdAt: t.createdAt ?? localIso(0, 8),
    completedAt: t.completedAt ?? null
  }))
  return `${JSON.stringify({ version: 1, tasks: full }, null, 2)}\n`
}

function storedTasks(fake: FakeAirship): Task[] {
  return (JSON.parse(fake.text(DATA)) as { tasks: Task[] }).tasks
}

async function mount(fake: FakeAirship, confirm?: boolean): Promise<Mount> {
  return mountUi(<DagogoApp api={fake.api} />, { fake, confirm })
}

/** 某一节的计数：节标题旁边那个数字 */
function sectionCount(m: Mount, label: string): number {
  const head = m.byText(label).parentElement?.textContent ?? ''
  return Number(head.replace(/\D/g, ''))
}

/** 勾选那颗按钮只有无障碍名称、没有文字，按名称找到它再点 */
async function clickField(m: Mount, name: string): Promise<void> {
  const el = m.field(name)
  if (!el) throw new Error(`界面上找不到名叫「${name}」的控件`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await m.settle()
}

/** 没有可读名称的输入框（改鼓励语）按选择器找 */
async function typeIn(m: Mount, selector: string, value: string): Promise<void> {
  const el = m.container.querySelector<HTMLInputElement>(selector)
  if (!el) throw new Error(`找不到输入框 ${selector}`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await m.settle()
}

describe('本地数据只认自家的形状', () => {
  it('DG-001 还没有记录文件时读到空表，界面是空态', async () => {
    const fake = shell()
    expect(await loadTasks(fake.api)).toEqual([])

    const m = await mount(fake)
    expect(m.text()).toContain('还没有记录。上面写一件，回车就行。')
    m.unmount()
  })

  it('DG-002 本地文件里 tasks 不是列表时报错文案原样上界面', async () => {
    const fake = shell({ [DATA]: '{"version":1,"tasks":{"a":1}}' })
    await expect(loadTasks(fake.api)).rejects.toThrow('本地数据格式不正确')

    const m = await mount(fake)
    expect(m.text()).toContain('读取失败：本地数据格式不正确')
    // 坏文件留在原地，不被改写
    expect(fake.text(DATA)).toBe('{"version":1,"tasks":{"a":1}}')
    m.unmount()
  })

  it('DG-003 本地文件里混进不像待办的项，只留下像的', async () => {
    const fake = shell({
      [DATA]: seedTasks([
        { id: 'a', title: '买菜', completedAt: null },
        { id: 'b', title: 42 as unknown as string },
        { id: 'd', title: '缺录入时间', createdAt: 1700000000 as unknown as string, completedAt: null },
        { id: 'c', title: '回电话', completedAt: localIso(0, 11) }
      ])
    })
    expect((await loadTasks(fake.api)).map((t) => t.title)).toEqual(['买菜', '回电话'])

    const m = await mount(fake)
    expect(m.text()).toContain('买菜')
    expect(m.text()).not.toContain('undefined')
    m.unmount()
  })
})

describe('与手机版互读的导出文件', () => {
  it('DG-004 导出的文件逐字带上 app: 打勾勾 与四个字段', async () => {
    const fake = shell({ [DATA]: seedTasks([{ id: 'a', title: '晨跑' }]) }, [['/fake/desktop/打勾勾.json']])
    const m = await mount(fake)
    await m.press('数据')
    await m.press('导出到文件')

    const file = JSON.parse(fake.text('/fake/desktop/打勾勾.json')) as Record<string, unknown>
    expect(Object.keys(file).sort()).toEqual(['app', 'exportedAt', 'tasks', 'version'])
    expect(file.app).toBe('打勾勾')
    expect(file.version).toBe(1)
    expect(typeof file.exportedAt).toBe('string')
    expect((file.tasks as Task[]).map((t) => t.title)).toEqual(['晨跑'])
    expect(m.text()).toContain('已导出：打勾勾.json')
    m.unmount()
  })

  it('DG-005 导出时没选地方就什么都不写', async () => {
    const fake = shell({ [DATA]: seedTasks([{ id: 'a', title: '晨跑' }]) }, [null])
    const m = await mount(fake)
    await m.press('数据')
    await m.press('导出到文件')

    expect([...fake.vol.keys()].filter((p) => p.endsWith('.json') && !p.startsWith('/fake/userData'))).toEqual([])
    expect(m.text()).not.toContain('已导出')
    m.unmount()
  })

  it('DG-006 裸数组与 {tasks: [...]} 两种都收', () => {
    const one = { id: 'a', title: '甲', createdAt: localIso(0, 8), completedAt: null }
    expect(normalizeImportedTasks([one])).toEqual([one])
    expect(normalizeImportedTasks({ version: 1, tasks: [one] })).toEqual([one])
  })

  it('DG-007 不像待办的与空标题的跳过，全跳光就说没有可导入的', () => {
    const good = { id: 'a', title: '甲', createdAt: localIso(0, 8), completedAt: null }
    expect(
      normalizeImportedTasks([
        good,
        { id: 'b', title: '   ', createdAt: localIso(0, 8), completedAt: null },
        { id: 'c', title: 7 as unknown as string, createdAt: localIso(0, 8), completedAt: null },
        { id: 'e', title: '  带空格  ', createdAt: localIso(0, 8), completedAt: null },
        '不是对象'
      ])
    ).toEqual([good, { ...good, id: 'e', title: '带空格' }])
    expect(() => normalizeImportedTasks([{ id: 'z', title: '', createdAt: 'x', completedAt: null }])).toThrow(
      '文件里没有可导入的待办'
    )
    expect(() => normalizeImportedTasks([])).toThrow('文件里没有可导入的待办')
  })

  it('DG-008 不是打勾勾的 JSON 就说清不是', () => {
    expect(() => normalizeImportedTasks({ something: 1 })).toThrow('文件不是打勾勾的 JSON 数据')
    expect(() => normalizeImportedTasks('一句中文')).toThrow('文件不是打勾勾的 JSON 数据')
    expect(() => normalizeImportedTasks(null)).toThrow('文件不是打勾勾的 JSON 数据')
  })

  it('DG-009 书号缺了或撞了都重排，一条都不少', () => {
    const base = { title: '甲', createdAt: localIso(0, 8), completedAt: null }
    const out = normalizeImportedTasks([
      { ...base, id: 'same' },
      { ...base, id: 'same' },
      { ...base, id: '' },
      { ...base, id: 'other' }
    ])
    expect(out.length).toBe(4)
    expect(new Set(out.map((t) => t.id)).size).toBe(4)
    expect(out.every((t) => t.id.length > 0)).toBe(true)
  })

  it('DG-010 导入是追加，新导入的排在前面', async () => {
    const fake = shell({ [DATA]: seedTasks([{ id: 'old', title: '原有的一条', createdAt: localIso(-1, 9) }]) }, [
      ['/fake/desktop/手机导出的.json']
    ])
    fake.seed(
      '/fake/desktop/手机导出的.json',
      JSON.stringify({
        app: '打勾勾',
        version: 1,
        exportedAt: localIso(0, 9),
        tasks: [
          { id: 'new1', title: '从手机来的', createdAt: localIso(-2, 9), completedAt: null },
          { id: 'new2', title: '另一条手机来的', createdAt: localIso(-2, 10), completedAt: localIso(-2, 11) }
        ]
      })
    )
    const m = await mount(fake)
    await m.press('数据')
    await m.press('从文件导入')

    expect(storedTasks(fake).map((t) => t.title)).toEqual(['从手机来的', '另一条手机来的', '原有的一条'])
    expect(m.text()).toContain('导入 2 条')
    m.unmount()
  })
})

describe('今天算今天', () => {
  it('DG-011 勾上写完成时间，取消抹掉不留历史', async () => {
    const fake = shell({ [DATA]: seedTasks([{ id: 'a', title: '晨跑' }]) })
    const m = await mount(fake)
    await clickField(m, '完成 晨跑')

    expect(storedTasks(fake)[0]!.completedAt).not.toBeNull()
    expect(sectionCount(m, '已完成')).toBe(1)

    await clickField(m, '取消完成 晨跑')
    expect(storedTasks(fake)[0]!.completedAt).toBeNull()
    expect(m.has('已完成')).toBe(false)
    expect(sectionCount(m, '待办')).toBe(1)
    m.unmount()
  })

  it('DG-012 顶部那句只数今天勾掉的，分母是全部条数', async () => {
    const fake = shell({
      [DATA]: seedTasks([
        { id: 'a', title: '今天的', createdAt: localIso(-3, 8), completedAt: localIso(0, 9) },
        { id: 'b', title: '昨天的', createdAt: localIso(-3, 8), completedAt: localIso(-1, 22) },
        { id: 'c', title: '还没做', createdAt: localIso(-3, 8), completedAt: null }
      ])
    })
    const m = await mount(fake)
    expect(m.text()).toContain('今天 1 / 3')
    // 与录入日期无关：三条都是三天前记下的
    expect(sectionCount(m, '已完成')).toBe(2)
    m.unmount()
  })

  it('DG-013 过了午夜算新的一天，昨天深夜勾掉的不进今天', async () => {
    expect(isToday(localIso(0, 0, 5))).toBe(true)
    expect(isToday(localIso(0, 23, 55))).toBe(true)
    expect(isToday(localIso(-1, 23, 55))).toBe(false)
    expect(isToday(localIso(1, 0, 5))).toBe(false)

    const fake = shell({
      [DATA]: seedTasks([{ id: 'a', title: '深夜收的尾', createdAt: localIso(-1, 22), completedAt: localIso(-1, 23, 50) }])
    })
    const m = await mount(fake)
    expect(m.text()).toContain('今天 0 / 1')
    expect(sectionCount(m, '已完成')).toBe(1)
    m.unmount()
  })

  it('DG-014 每行念得出录入与完成时间，今天发生的只报时刻', async () => {
    const fake = shell({
      [DATA]: seedTasks([{ id: 'a', title: '交水电费', createdAt: localIso(-2, 8, 5), completedAt: localIso(0, 9, 6) }])
    })
    const m = await mount(fake)
    expect(m.text()).toMatch(/\d+月\d+日 08:05 录入/)
    expect(m.text()).toContain('· 09:06 完成')
    m.unmount()
  })
})

describe('界面默认只说今天要做什么', () => {
  it('DG-015 写一件回车就进列表，界面读得出它', async () => {
    const fake = shell()
    const m = await mount(fake)
    await m.type('记一件要做的事，回车添加', '给妈妈回电话')
    await m.key('Enter')

    expect(m.text()).toContain('给妈妈回电话')
    expect(sectionCount(m, '待办')).toBe(1)
    expect(storedTasks(fake).map((t) => t.title)).toEqual(['给妈妈回电话'])
    m.unmount()
  })

  it('DG-016 待办与已完成两节各带计数，空的那节不出现', async () => {
    const fake = shell({
      [DATA]: seedTasks([
        { id: 'a', title: '要做的一件', completedAt: null },
        { id: 'b', title: '做成的一件', completedAt: localIso(0, 9) },
        { id: 'c', title: '另要做的一件', completedAt: null }
      ])
    })
    const m = await mount(fake)
    expect(sectionCount(m, '待办')).toBe(2)
    expect(sectionCount(m, '已完成')).toBe(1)
    m.unmount()

    const onlyOne = shell({ [DATA]: seedTasks([{ id: 'a', title: '独一件', completedAt: null }]) })
    const m2 = await mount(onlyOne)
    expect(m2.has('已完成')).toBe(false)
    m2.unmount()
  })

  it('DG-017 鼓励语点得开也改得掉，改后落进设置', async () => {
    const fake = shell()
    const m = await mount(fake)
    expect(m.text()).toContain('一件一件，慢慢来')

    await m.press('一件一件，慢慢来')
    await typeIn(m, '.dagogo__enc-input', '先做最难的那件')
    await m.press('保存')

    expect(m.text()).toContain('先做最难的那件')
    expect(fake.settingsStore['prefs']).toEqual({ encouragement: '先做最难的那件', background: null })
    m.unmount()
  })

  it('DG-018 删除要先确认，句子带标题原文；不确认就什么都不动', async () => {
    const data = seedTasks([{ id: 'a', title: '买菜', completedAt: null }])

    const refused = await mount(shell({ [DATA]: data }), false)
    await refused.press('删除')
    expect(refused.text()).toContain('买菜')
    expect(storedTasks(refused.fake!).length).toBe(1)
    refused.unmount()

    let asked = ''
    const spy = vi.spyOn(window, 'confirm').mockImplementation((message?: string) => {
      asked = message ?? ''
      return true
    })
    const confirmed = await mount(shell({ [DATA]: data }))
    await confirmed.press('删除')
    spy.mockRestore()

    expect(asked).toBe('删除「买菜」？录入和完成时间会一起删掉。')
    expect(confirmed.has('买菜')).toBe(false)
    expect(storedTasks(confirmed.fake!)).toEqual([])
    confirmed.unmount()
  })

  it('DG-019 没写字的时候添加那颗点不动', async () => {
    const fake = shell()
    const m = await mount(fake)
    expect(m.byText('添加').disabled).toBe(true)

    await m.type('记一件要做的事，回车添加', '   ')
    expect(m.byText('添加').disabled).toBe(true)

    await m.type('记一件要做的事，回车添加', '一件要做的事')
    expect(m.byText('添加').disabled).toBe(false)
    await m.press('添加')
    expect(m.text()).toContain('一件要做的事')
    expect(sectionCount(m, '待办')).toBe(1)
    expect((m.container.querySelector('.dagogo__add-input') as HTMLInputElement).value).toBe('')
    m.unmount()
  })
})

describe('托盘上是今天的数', () => {
  it('DG-020 托盘提示文字念得出今天勾掉数与总数', async () => {
    const fake = shell({
      [DATA]: seedTasks([
        { id: 'a', title: '勾掉的', completedAt: localIso(0, 9) },
        { id: 'b', title: '没勾的', completedAt: null }
      ])
    })
    const m = await mount(fake)
    expect(fake.trayState?.tooltip).toBe('打勾勾 · 今天勾掉 1 个，共 2 条')
    expect(fake.trayState?.iconDataUrl).toBe('data:image/png;base64,FAKE1')
    expect(fake.trayState?.focusOnClick).toBe(true)
    m.unmount()
  })

  it('DG-021 再勾一个，托盘上的数字跟着进一位', async () => {
    const fake = shell({
      [DATA]: seedTasks([
        { id: 'a', title: '第一件', completedAt: localIso(0, 9) },
        { id: 'b', title: '第二件', completedAt: null }
      ])
    })
    const m = await mount(fake)
    expect(fake.trayState?.tooltip).toContain('今天勾掉 1 个')
    await clickField(m, '完成 第二件')
    expect(fake.trayState?.tooltip).toBe('打勾勾 · 今天勾掉 2 个，共 2 条')
    m.unmount()
  })

  it('DG-022 打勾勾的窗口关了，托盘跟着撤掉', async () => {
    const fake = shell({ [DATA]: seedTasks([{ id: 'a', title: '一件', completedAt: null }]) })
    const m = await mount(fake)
    expect(fake.trayState).not.toBeNull()
    m.unmount()
    expect(fake.trayState).toBeNull()
  })
})
