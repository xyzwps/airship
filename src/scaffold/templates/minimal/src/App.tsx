import { useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import './app.css'

/**
 * 应用本体：宿主把 `api` 当 prop 递进来，组件只管画与算。
 *
 * 配色一律用宿主给的 CSS 变量（`var(--fg)` 那一族），别写死颜色——
 * 主题三档由标题栏那颗键改，`useTheme()` 读到的就是落地后的那一档。
 * 想碰系统就经 `api.` 的对应域，并回到 `app.ts` 的 `capabilities` 里把那个域声明上。
 */
export default function App({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [count, setCount] = useState(0)

  return (
    <div className="app">
      <h2>__APP_NAME__</h2>
      <p className="hint">
        现在亮的是{resolved === 'dark' ? '暗色' : '亮色'}那一档，配色跟着标题栏那颗主题键走。
      </p>
      <p>
        按了 {count} 次。
      </p>
      <button type="button" onClick={() => setCount(count + 1)}>
        点我
      </button>
    </div>
  )
}
