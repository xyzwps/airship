import type { AppApi } from '@airship/contract'

/**
 * 壳侧设置与 localStorage 形状之间的适配器。
 *
 * Albedo 的自动保存、语言、最近字体原来都走 localStorage（同步读写、失败靠抛）；
 * 在包里这层换成 `api.settings`（能力 settings），但给上层留**同一个同步面**：
 *   读：内存镜像，立刻有值；
 *   写：先进镜像再进待落盘队列，`flush()` 由 saveNow 那层 await。
 * flush 中途失败要抛出去——保存状态灯念"未保存"靠的就是这一下，不能咽。
 * 落盘的每个键值是 JSON 字符串（与原来 localStorage 里的字节形状一致）。
 */

export interface Store {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  hydrate(): Promise<void>
  flush(): Promise<void>
}

export const STORE_KEYS = {
  doc: 'doc',
  source: 'source',
  underlay: 'underlay',
  lang: 'lang',
  recentFonts: 'recentFonts'
} as const

export function createStore(api: AppApi): Store {
  const mirror = new Map<string, string>()
  const dirty = new Map<string, string | null>()

  return {
    getItem: (key) => (mirror.has(key) ? mirror.get(key)! : null),

    setItem: (key, value) => {
      mirror.set(key, value)
      dirty.set(key, value)
    },

    removeItem: (key) => {
      mirror.delete(key)
      dirty.set(key, null)
    },

    hydrate: async () => {
      const dump = await api.settings.dump()
      for (const [k, v] of Object.entries(dump)) {
        if (typeof v === 'string') {
          mirror.set(k, v)
          dirty.delete(k)
        }
      }
    },

    flush: async () => {
      if (dirty.size === 0) return
      const batch = [...dirty.entries()]
      dirty.clear()
      for (let i = 0; i < batch.length; i += 1) {
        const [k, v] = batch[i]!
        try {
          await api.settings.set(k, v)
        } catch (err) {
          // 这一条和它之后的都没写进去：重新挂脏，让下一次 flush 再试，并把原话抛给调用方
          for (let j = i; j < batch.length; j += 1) dirty.set(batch[j]![0], batch[j]![1])
          throw err
        }
      }
    }
  }
}
