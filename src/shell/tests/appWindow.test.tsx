// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { FakeAirship } from './helpers/fakeAirship'
import { mountUi } from './helpers/mount'

/**
 * SH-011 ~ SH-014：应用窗口里壳添的那三样东西（标题栏、内容区留白、占位）。
 *
 * 这里必须给注册表装替身——被测的是宿主窗口，不是四个应用本体：
 * 真挂载 vcp 会把 ffmpeg 探测那一整套拖进来，那属于 `vcp.md` 的用例。
 */

vi.mock('../../apps', async () => {
  const { lazy } = await import('react')
  const iconUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
  const metas = {
    vcp: { id: 'vcp', name: 'vcp', description: '编排台', accent: '#e0834a', capabilities: ['log'], flush: true },
    plain: { id: 'plain', name: '素面应用', description: '要壳给留白的', accent: '#333', capabilities: ['log'] },
    slow: { id: 'slow', name: '慢热应用', description: 'chunk 还没到', accent: '#444', capabilities: ['log'] }
  } as const

  const entries = {
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
  it('SH-011 标题栏念得出"飞船 / 应用名"，三颗键各有可读名称', async () => {
    const m = await mountHost('vcp')
    const visible = m.text()
    expect(visible).toContain('飞船')
    expect(visible).toContain('vcp')
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

  it('SH-014 开了个不存在的应用，界面说清怎么修', async () => {
    const m = await mountHost('ghost')
    const visible = m.text()
    expect(visible).toContain('没有注册这个应用：ghost')
    expect(visible).toContain('apps/ghost/app.ts')
    expect(visible).toContain('id 与目录名一致')
    m.unmount()
  })
})
