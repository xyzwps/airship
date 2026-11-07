// @vitest-environment jsdom
import { lazy, useEffect, type ComponentType, type JSX } from 'react'
import { describe, expect, it } from 'vitest'
import { AirshipRoot } from '@airship/sdk'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi } from '@airship/sdk/testing'
import type { AppApi, AppMeta } from '@airship/contract'

/**
 * SH-011 / SH-012 / SH-013 / SH-019：应用窗口里壳添的那三样东西。
 *
 * 实现住在 `src/sdk/host.tsx`（一个包自持一份文档，壳不往应用窗口里注 DOM），
 * 用例也就住到这里；契约编号没变——用户看见的还是那三样：
 * 标题栏只念应用名、留白按清单给、界面在路上时有占位。
 *
 * 挂的是**真宿主 + 假应用**：真去挂某个应用就把那本应用册子的东西全拖进来了
 * （vcp 会把 ffmpeg 探测那一整套拉进来），那属于 `vcp.md` 的用例。
 */

const ICON = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='

function meta(over: Partial<AppMeta> & { id: string; name: string }): AppMeta {
  return { description: '测试用', capabilities: [], ...over } as AppMeta
}

/** 宿主自己从 `window.airship` 造 api，所以这里只需要把替身挂上去 */
function mountSdkHost(manifest: AppMeta, component: ComponentType<{ api: AppApi }>, icon: string | undefined = ICON) {
  const fake = new FakeAirship({ id: manifest.id, capabilities: manifest.capabilities as never })
  return mountUi(<AirshipRoot meta={manifest} component={component} icon={icon} />, { fake })
}

describe('应用窗口里壳只添三样东西', () => {
  it('SH-011 应用窗口的标题栏只念应用名，三颗键各有可读名称', async () => {
    const m = await mountSdkHost(meta({ id: 'vcp', name: 'vcp' }), () => <div className="app-body">编排台正文</div>)
    const visible = m.text()
    expect(visible).toContain('vcp')
    // 这扇窗就是那个应用，不需要再自报家门一次
    expect(visible, '应用窗口的标题栏不该带「飞船」前缀').not.toContain('飞船')
    expect(visible).not.toContain('/')
    expect(m.container.querySelector('.titlebar__app-glyph')).not.toBeNull()

    for (const name of ['最小化', '最大化', '关闭']) {
      expect(m.container.querySelector(`[aria-label="${name}"]`), `标题栏缺「${name}」那颗键`).not.toBeNull()
    }
    m.unmount()
  })

  it('SH-012 要不要留白由清单说了算', async () => {
    const flush = await mountSdkHost(meta({ id: 'plain', name: '素面应用', flush: true }), () => (
      <div className="app-body">素面正文</div>
    ))
    expect(flush.container.querySelector('.app-window__body--flush'), 'flush 的包不该有内边距').not.toBeNull()
    expect(flush.text()).toContain('素面正文')
    flush.unmount()

    const padded = await mountSdkHost(meta({ id: 'roomy', name: '要留白的应用' }), () => (
      <div className="app-body">留白正文</div>
    ))
    expect(padded.container.querySelector('.app-window__body')).not.toBeNull()
    expect(padded.container.querySelector('.app-window__body--flush')).toBeNull()
    expect(padded.text()).toContain('留白正文')
    padded.unmount()
  })

  it('SH-013 应用界面还在路上时读得到占位，不是一片空白', async () => {
    // 包自己内部再切一层懒加载：宿主那圈 Suspense 就是这时起作用
    const pending = new Promise<{ default: ComponentType<{ api: AppApi }> }>(() => undefined)
    const Slow = lazy(() => pending)
    const m = await mountSdkHost(meta({ id: 'slow', name: '慢热应用' }), Slow)
    expect(m.container.querySelector('.spinner'), '加载途中该有占位').not.toBeNull()
    expect(m.text()).not.toContain('慢热正文')
    m.unmount()
  })

  it('SH-019 应用交来的标题落在标题栏中段，收回就空', async () => {
    let handed: AppApi | null = null
    const Titled: ComponentType<{ api: AppApi }> = ({ api }) => {
      useEffect(() => {
        handed = api
        void api.window.setTitle('第一推动·畅销经典')
      }, [api])
      return null
    }
    const m = await mountSdkHost(meta({ id: 'titled', name: '带标题的应用' }), Titled)
    await m.settle()
    const center = m.container.querySelector('.titlebar__center')
    expect(center, '标题栏该有一块中段').not.toBeNull()
    expect(center!.textContent).toBe('第一推动·畅销经典')
    // 任务栏那侧由主进程拼「应用名 · 书名」，这里只验渲染侧中段跟着走
    expect(m.fake!.windowTitles.at(-1)).toBe('第一推动·畅销经典')

    await handed!.window.setTitle(null)
    await m.settle()
    expect(m.container.querySelector('.titlebar__center')!.textContent).toBe('')
    m.unmount()
  })

  it('SH-011b 包没给图标时标题栏也念得出应用名', async () => {
    const m = await mountSdkHost(meta({ id: 'nograph', name: '没给图标的包' }), () => null, undefined)
    expect(m.text()).toContain('没给图标的包')
    expect(m.container.querySelector('.titlebar__brand')).not.toBeNull()
    m.unmount()
  })
})
