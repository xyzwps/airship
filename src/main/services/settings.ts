import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { appSettingsFile, shellSettingsFile } from './paths'
import { log } from './logging'
import type { AppId } from '../../shared/protocol'

/**
 * 设置存储：每个应用一个 JSON 文件，壳自己一个。
 *
 * 内存里保留一份，写盘用"临时文件 + rename"落，避免中途崩掉写坏原文件。
 * 键是扁平的字符串，值必须是可 JSON 序列化的东西。
 */

type Store = Record<string, unknown>

const cache = new Map<string, Store>()

function fileFor(app: AppId | 'shell'): string {
  return app === 'shell' ? shellSettingsFile() : appSettingsFile(app)
}

function load(app: AppId | 'shell'): Store {
  const hit = cache.get(app)
  if (hit) return hit

  const file = fileFor(app)
  let store: Store = {}
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as Store
      }
    }
  } catch (err) {
    // 文件坏了不致命：留一份 .bad 供排查，从空设置重新开始
    log.error(app === 'shell' ? 'shell' : app, '设置文件解析失败，已重置', {
      file,
      error: String(err)
    })
    try {
      renameSync(file, file + '.bad')
    } catch {
      /* 改名失败就算了 */
    }
  }

  cache.set(app, store)
  return store
}

function persist(app: AppId | 'shell'): void {
  const file = fileFor(app)
  const store = cache.get(app) ?? {}
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8')
  renameSync(tmp, file)
}

export const settings = {
  get<T>(app: AppId | 'shell', key: string, fallback: T): T {
    const store = load(app)
    const value = store[key]
    return value === undefined ? fallback : (value as T)
  },

  set<T>(app: AppId | 'shell', key: string, value: T): void {
    const store = load(app)
    if (value === undefined) {
      delete store[key]
    } else {
      store[key] = value as unknown
    }
    persist(app)
  },

  dump(app: AppId | 'shell'): Store {
    // 返回副本，别让渲染侧拿到能直接改的引用
    return { ...load(app) }
  }
}
