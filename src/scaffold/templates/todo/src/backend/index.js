/**
 * __APP_NAME__ 的后端：随包自带、由 runtime 起成它自己的一份进程。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 数据目录从 `AIRSHIP_DATA_DIR` 拿——只有这个应用那一族碰得到，卸载也不跟着删。
 *
 * 它崩了不拖累窗口：在途的调用会听到「后端程序中途退出」，下一次调用拉起新的进程。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const parent = process.parentPort
const FILE = join(process.env.AIRSHIP_DATA_DIR ?? '.', 'todos.json')

function load() {
  if (!existsSync(FILE)) return []
  return JSON.parse(readFileSync(FILE, 'utf8'))
}

function save(items) {
  mkdirSync(join(FILE, '..'), { recursive: true })
  writeFileSync(FILE, `${JSON.stringify(items, null, 2)}\n`, 'utf8')
}

const handlers = {
  list: () => load(),
  add: (payload) => {
    const text = String(payload?.text ?? '').trim()
    if (text === '') throw new Error('不能加一条空待办')
    const items = load()
    const item = { id: items.reduce((max, t) => Math.max(max, t.id), 0) + 1, text, done: false }
    items.push(item)
    save(items)
    return item
  },
  toggle: (payload) => {
    const items = load()
    const item = items.find((t) => t.id === payload?.id)
    if (!item) throw new Error('没有这条待办')
    item.done = !item.done
    save(items)
    return item
  },
  remove: (payload) => {
    const items = load()
    const kept = items.filter((t) => t.id !== payload?.id)
    if (kept.length === items.length) throw new Error('没有这条待办')
    save(kept)
    return kept
  }
}

parent.on('message', (event) => {
  const { seq, method, payload } = event.data ?? {}
  try {
    const handler = handlers[method]
    if (!handler) throw new Error(`后端不认的方法：${method}`)
    parent.postMessage({ seq, ok: true, value: handler(payload) })
  } catch (e) {
    parent.postMessage({ seq, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

parent.postMessage({ ready: true })
