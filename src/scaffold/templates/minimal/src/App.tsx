import { useEffect, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import './app.css'

/** 把 invoke 的失败收成那句人话：后端回的 error 原样就是给用户的 */
function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 应用本体：宿主把 `api` 当 prop 递进来，组件只管画与算。
 *
 * 计数不在这里——它住在随包自带的后端进程（`src/backend.ts`）的内存里：
 * 开窗时 `get` 一次拿现值，点一下是一次 `inc` 请求-回话。
 * 有没有后台由包形状说了算（旁边那份 backend.ts 就是），不进清单。
 *
 * 配色一律用宿主给的 CSS 变量（`var(--fg)` 那一族），别写死颜色——
 * 主题三档由标题栏那颗键改，`useTheme()` 读到的就是落地后的那一档。
 * 想碰系统就经 `api.` 的对应域，边界是 grants 的文件路径表与身份闸。
 */
export default function App({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.backend
      .invoke<number>('get')
      .then((n) => {
        if (alive) setCount(n)
      })
      .catch((e) => {
        if (alive) setError(reasonOf(e))
      })
    return () => {
      alive = false
    }
  }, [api])

  async function bump(): Promise<void> {
    try {
      setCount(await api.backend.invoke<number>('inc'))
      setError(null)
    } catch (e) {
      setError(reasonOf(e))
    }
  }

  return (
    <div className="app">
      <h2>__APP_NAME__</h2>
      <p className="hint">
        现在亮的是{resolved === 'dark' ? '暗色' : '亮色'}那一档，配色跟着标题栏那颗主题键走。
      </p>
      <p>{count === null ? '从后端取计数…' : `按了 ${count} 次。`}</p>
      <button type="button" onClick={() => void bump()}>
        点我
      </button>
      {error !== null && <p className="error">{error}</p>}
    </div>
  )
}
