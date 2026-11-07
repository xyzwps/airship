import { useEffect, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import './CHANGE_ME.css'

/**
 * 应用本体。
 *
 * 三条约束是这个仓库的规矩，不是建议：
 *   1. 只引 `@airship/sdk` 与 `@airship/contract`，不许引壳（AP-013）；
 *   2. 碰系统只经 `api.`，用到哪个域就得在 `app.ts` 里声明哪个能力（AP-011）；
 *   3. 配色用宿主给的 CSS 变量（`var(--fg)` 那一族），不自己另调一套（主题三档只有启动器能改）。
 */
export default function ChangeMeApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    // 应用专用接口都要声明能力：这里想读写设置，就把 'settings' 加进 app.ts 的 capabilities
    setReady(true)
  }, [api])

  return (
    <div className="change-me">
      <h2>显示名</h2>
      <p className="hint">
        现在亮的是{resolved === 'dark' ? '暗色' : '亮色'}那一档，配色跟着启动器那颗键走。
      </p>
      <p>{ready ? '应用已经画出来了。' : '正在准备…'}</p>
    </div>
  )
}
