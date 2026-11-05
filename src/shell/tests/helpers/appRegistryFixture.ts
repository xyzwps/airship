import { lazy, type ComponentType } from 'react'
import type { AppEntry } from '../../src/apps'
import type { AppApi, AppMeta } from '@shared/protocol'
import type { AppMeta as Meta } from '@shared/app'

/**
 * 假的应用注册表。
 *
 * 壳侧用例（启动器、应用宿主）要验的是"壳怎么摆应用"，不是"这四个应用长什么样"，
 * 所以这里给一组可控的清单：想试 `flush` 的差异、平台过滤、图标缺失，改这份就行。
 * 注册表本身（glob 发现、缺件即炸、字典序）由 app-model 那本册子的用例对着真代码验。
 */

export function meta(over: Partial<Meta> & { id: string; name: string }): AppMeta {
  return {
    description: '测试用清单',
    accent: '#123456',
    capabilities: ['log'],
    ...over
  } as AppMeta
}

/** 造一个注册表入口：组件是一个立刻可用的 lazy */
export function entry(m: AppMeta, component: ComponentType<{ api: AppApi }> = () => null): AppEntry {
  const loader = () => Promise.resolve({ default: component })
  return {
    meta: m,
    iconUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    component: lazy(loader),
    flush: m.flush === true,
    load: loader
  }
}

/** 组件还在路上（验占位用）的入口 */
export function pendingEntry(m: AppMeta): AppEntry {
  const loader = () => new Promise<{ default: ComponentType<{ api: AppApi }> }>(() => undefined)
  return {
    meta: m,
    iconUrl: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    component: lazy(loader as never),
    flush: m.flush === true,
    load: loader
  }
}
