import { useEffect, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import './CHANGE_ME.css'

/**
 * 应用本体。
 *
 * 三条约束是这个仓库的规矩，不是建议：
 *   1. 只引 `@airship/sdk` 与 `@airship/contract`，不许引 runtime（AP-013）；
 *   2. 碰系统只经 `api.`，共享区与外部工具要在 `app.ts` 的名单里声明（两份真名单）；
 *   3. 配色用宿主给的 CSS 变量（`var(--fg)` 那一族），不自己另调一套（主题三档由标题栏那颗键改，各应用各记各的）。
 */
export default function ChangeMeApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // api 的通道随取随用：想读写设置，直接 api.settings. 就行，清单不再声明能力
    setReady(true)
  }, [api])

  return (
    <div className="change-me">
      <h2>显示名</h2>
      <p className="hint">
        现在亮的是{resolved === 'dark' ? '暗色' : '亮色'}那一档，配色跟着标题栏那颗主题键走。
      </p>
      <p>{ready ? '应用已经画出来了。' : '正在准备…'}</p>
    </div>
  )
}
