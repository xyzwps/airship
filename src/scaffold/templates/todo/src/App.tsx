import { useEffect, useState, type JSX } from 'react'
import type { AppApi } from '@airship/contract'
import './app.css'

type Item = { id: number; text: string; done: boolean }

/** 把 invoke 的失败收成那句人话：后端回的 error 原样就是给用户的 */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 前端这一半：只渲染状态、只发调用，不碰磁盘。
 *
 * 每一次 `api.backend.invoke(method, payload)` 是一次请求-回话：
 * await 到的就是后端 handler 的返回值；后端回的失败会原样 reject 成那句人话。
 */
export default function App({ api }: { api: AppApi }): JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      setItems(await api.backend.invoke<Item[]>('list'))
      setError(null)
    } catch (e) {
      setError(reasonOf(e))
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function add() {
    const t = text.trim()
    if (t === '') return
    try {
      await api.backend.invoke('add', { text: t })
      setText('')
      await refresh()
    } catch (e) {
      setError(reasonOf(e))
    }
  }

  async function toggle(id: number) {
    try {
      const item = await api.backend.invoke<Item>('toggle', { id })
      setItems((old) => old.map((t) => (t.id === item.id ? item : t)))
      setError(null)
    } catch (e) {
      setError(reasonOf(e))
    }
  }

  async function remove(id: number) {
    try {
      await api.backend.invoke('remove', { id })
      setItems((old) => old.filter((t) => t.id !== id))
      setError(null)
    } catch (e) {
      setError(reasonOf(e))
    }
  }

  return (
    <div className="app">
      <h2>__APP_NAME__</h2>
      <form
        className="add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          value={text}
          placeholder="想做点什么？"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit">加上</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="list">
        {items.map((item) => (
          <li key={item.id} className={item.done ? 'done' : ''}>
            <label>
              <input type="checkbox" checked={item.done} onChange={() => void toggle(item.id)} />
              <span>{item.text}</span>
            </label>
            <button type="button" className="del" onClick={() => void remove(item.id)}>
              删掉
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="empty">还没有待办，加一条。</li>}
      </ul>
    </div>
  )
}
