import { Suspense, useEffect, useState, type JSX } from 'react'
import { entryFor, isKnownApp } from '../apps'
import { makeAppApi } from './api'
import type { AppApi } from '@shared/protocol'
import { Titlebar } from './Titlebar'
import { useTheme } from './theme'
import { useReportShotReady } from './shot'

/**
 * 单应用宿主窗口。
 *
 * 这个窗口里只有一个应用：壳给它一份已绑定身份的 api，剩下全是应用自己的事。
 * 应用崩了只崩这个窗口，主进程按 event.sender 判归属，别的应用既看不到也收不到它的事件。
 *
 * 主题在这里落地：每个窗口是独立文档，宿主不读主题，整个窗口就没有 CSS 变量。
 */
export function AppHost({ appId }: { appId: string }): JSX.Element {
  const [docTitle, setDocTitle] = useState<string | null>(null)
  const [api] = useState<AppApi>(() => makeAppApi(appId, { onWindowTitle: setDocTitle }))
  const entry = entryFor(appId)
  // 只读：应用不能改主题，但必须把主题画出来
  useTheme()

  /**
   * 组件 chunk 是否已经 resolve。
   * 截图模式要等这个而不是等宿主挂载——宿主挂载时 Suspense 可能还在转圈，
   * 截出来就是一张 spinner，看着像"跑起来了"其实什么都没验。
   */
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    if (!entry) return
    let alive = true
    void entry.load().then(() => alive && setLoaded(true))
    return () => {
      alive = false
    }
  }, [entry])

  useReportShotReady([appId, loaded])

  if (!isKnownApp(appId) || !entry) {
    return (
      <div className="app-window">
        <Titlebar />
        <div className="placeholder">
          <div className="error">没有注册这个应用：{appId}</div>
          <div className="hint">检查 apps/{appId}/app.ts 是否存在，且 id 与目录名一致。</div>
        </div>
      </div>
    )
  }

  const Component = entry.component

  return (
    <div className="app-window">
      <Titlebar
        here={entry.meta.name}
        center={docTitle}
        icon={<img src={entry.iconUrl} alt="" className="titlebar__app-glyph" />}
      />
      <div className={`app-window__body${entry.flush ? ' app-window__body--flush' : ''}`}>
        <Suspense
          fallback={
            <div className="placeholder">
              <div className="spinner" />
            </div>
          }
        >
          <Component api={api} />
        </Suspense>
      </div>
    </div>
  )
}
