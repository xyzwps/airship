// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { FakeAirship } from './helpers/fakeAirship'
import type { AppApi } from '@shared/protocol'
import { mountUi } from './helpers/mount'

/**
 * SH-011 ~ SH-014：应用窗口里壳添的那三样东西（标题栏、内容区留白、占位）。
 *
 * 这里必须给注册表装替身——被测的是宿主窗口，不是四个应用本体：
 * 真挂载 vcp 会把 ffmpeg 探测那一整套拖进来，那属于 `vcp.md` 的用例。
 */

vi.mock('../../apps', async () => {
  const { lazy, useEffect } = await import('react')
  const iconUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  const metas = {
    vcp: { id: 'vcp', name: 'vcp', description: '编排台', capabilities: ['log'], flush: true },
    plain: { id: 'plain', name: '素面应用', description: '要壳给留白的', capabilities: ['log'] },
    slow: { id: 'slow', name: '慢热应用', description: 'chunk 还没到', capabilities: ['log'] },
    titled: { id: 'titled', name: '带标题的应用', description: '挂载时交出书名', capabilities: ['log'] }
  } as const

  const entries = {
    titled: {
      meta: metas.titled,
      iconUrl,
      flush: false,
      component: lazy(() =>
        Promise.resolve({
          default: ({ api }: { api: AppApi }) => {
            useEffect(() => {
              void api.window.setTitle('第一推动·畅销经典')
              // 把应用真正拿到的那份 api 交出来：收回标题要走同一条路（宿主在 makeAppApi 里包过一层）
              ;(globalThis as unknown as { __titledApi?: AppApi }).__titledApi = api
            }, [])
            return null
          }
        })
      ),
      load: () => Promise.resolve({ default: () => null })
    },
    vcp: {
      meta: metas.vcp,
      iconUrl,
      flush: true,
      component: lazy(() => Promise.resolve({ default: () => <div className="app-body">编排台正文</div> })),
      load: () => Promise.resolve({ default: () => <div>编排台正文</div> })
    },
    plain: {
      meta: metas.plain,
      iconUrl,
      flush: false,
      component: lazy(() => Promise.resolve({ default: () => <div className="app-body">素面正文</div> })),
      load: () => Promise.resolve({ default: () => <div>素面正文</div> })
    },
    // 组件在路上：load 永不 resolve，宿主应该画占位而不是一片空白
    slow: {
      meta: metas.slow,
      iconUrl,
      flush: false,
      component: lazy(() => new Promise<never>(() => undefined)),
      load: () => new Promise<never>(() => undefined)
    }
  } as Record<string, never>

  return {
    APP_ENTRIES: entries,
    APPS: Object.values(metas),
    isKnownApp: (id: string) => id in entries,
    entryFor: (id: string) => entries[id] ?? null,
    entriesAvailableOn: () => Object.values(entries)
  }
})

const { AppHost } = await import('../AppHost')

function mountHost(appId: string) {
  const fake = new FakeAirship({ id: appId, capabilities: ['log'] })
  return mountUi(<AppHost appId={appId} />, { fake })
}

describe('应用窗口里壳只添三样东西', () => {
  it('SH-011 应用窗口的标题栏只念应用名，三颗键各有可读名称', async () => {
    const m = await mountHost('vcp')
    const visible = m.text()
    expect(visible).toContain('vcp')
    // 这扇窗就是那个应用，不需要再自报家门一次
    expect(visible, '应用窗口的标题栏不该带「飞船 /」前缀').not.toContain('飞船')
    expect(visible).not.toContain('/')
    expect(m.container.querySelector('.titlebar__app-glyph')).not.toBeNull()

    for (const name of ['最小化', '最大化', '关闭']) {
      expect(m.container.querySelector(`[aria-label="${name}"]`), `标题栏缺「${name}」那颗键`).not.toBeNull()
    }
    m.unmount()
  })

  it('SH-012 要不要留白由清单说了算', async () => {
    const flush = await mountHost('vcp')
    expect(flush.container.querySelector('.app-window__body--flush')).not.toBeNull()
    expect(flush.text()).toContain('编排台正文')
    flush.unmount()

    const padded = await mountHost('plain')
    expect(padded.container.querySelector('.app-window__body')).not.toBeNull()
    expect(padded.container.querySelector('.app-window__body--flush')).toBeNull()
    expect(padded.text()).toContain('素面正文')
    padded.unmount()
  })

  it('SH-013 组件还在路上时读得到占位，不是一片空白', async () => {
    const m = await mountHost('slow')
    expect(m.container.querySelector('.spinner')).not.toBeNull()
    expect(m.text()).not.toContain('慢热应用正文')
    m.unmount()
  })

  it('SH-019 应用交来的标题落在标题栏中段，收回就空', async () => {
    const m = await mountHost('titled')
    const fake = m.fake!
    await m.settle()
    const center = m.container.querySelector('.titlebar__center')
    expect(center, '标题栏该有一块中段').not.toBeNull()
    expect(center!.textContent).toBe('第一推动·畅销经典')
    // 任务栏那侧由主进程拼「应用名 · 书名」，这里只验渲染侧中段跟着走
    expect(fake.windowTitles.at(-1)).toBe('第一推动·畅销经典')

    const handed = (globalThis as unknown as { __titledApi?: AppApi }).__titledApi!
    await handed.window.setTitle(null)
    await m.settle()
    expect(m.container.querySelector('.titlebar__center')!.textContent).toBe('')
    m.unmount()
  })

  it('SH-014 开了个不存在的应用，界面说清怎么修', async () => {
    const m = await mountHost('ghost')
    const visible = m.text()
    expect(visible).toContain('没有注册这个应用：ghost')
    expect(visible).toContain('apps/ghost/app.ts')
    expect(visible).toContain('id 与目录名一致')
    m.unmount()
  })
})
