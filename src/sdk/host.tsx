import { StrictMode, Suspense, useEffect, useState, type ComponentType, type JSX } from 'react'
import { createRoot } from 'react-dom/client'
import { createAirshipApi } from './api.ts'
import { Titlebar } from './Titlebar.tsx'
import { useTheme } from './theme.ts'
import { useReportShotReady } from './shot.ts'
import './styles/airship.css'
import type { AppApi } from '@airship/contract'
import type { AppMeta } from '@airship/contract'

/**
 * SDK 的应用宿主。
 *
 * 一个 airship 包自持一份文档（`airship://<id>/index.html`），这份文档里长出来的
 * 壳性东西由这里给：标题栏（应用名 + `api.window.setTitle` 那行的中段）、主题落地、
 * `flush` 留白、加载占位。这些原来住在壳的 `AppHost.tsx` 里，窗口加载的是壳的 app.html；
 * 搬过来之后**壳不再往应用窗口注入任何 DOM**。
 *
 * 留给工装的一条接缝：宿主画完把 `document.documentElement.dataset.airshipMounted`
 * 置成应用 id——"这个窗口真的画出东西了"由此可查，不需要应用配合。
 *
 * 主题三档只有启动器能改，应用窗口读到的就是壳定的那一档。
 */

export interface AirshipAppOptions {
  /** 应用自己的清单，就是 `app.ts` 导出的那份 */
  meta: AppMeta
  /** 应用组件：`({ api }) => …` */
  component: ComponentType<{ api: AppApi }>
  /** 包根那张图标的相对路径，例如 `'./icon.svg'`；标题栏用它画那枚 15px 记号 */
  icon?: string
}

/**
 * 把一个应用装进它自己的文档。应用侧的 `main.tsx` 只写这一行：
 *
 *   createAirshipApp({ meta: app, component: LifeApp, icon: './icon.svg' })
 */
export function createAirshipApp(options: AirshipAppOptions): void {
  const container = document.getElementById('root')
  if (!container) throw new Error('#root 不存在：包的入口 html 里得有 <div id="root"></div>')

  createRoot(container).render(
    <StrictMode>
      <AirshipRoot {...options} />
    </StrictMode>
  )
}

/**
 * 宿主本体。`createAirshipApp` 就是把它装进 `#root`。
 *
 * 单独导出不是为了应用用——应用只写那一行——而是为了让"标题栏念什么、留白哪一档、
 * 画完没有"这三条判据有用例可挂（`src/sdk/tests/appWindow.test.tsx`）。
 * 走的是同一条渲染路径，不存在"测试里绿的那个宿主不是产品里那个宿主"。
 */
export function AirshipRoot({ meta, component: Component, icon }: AirshipAppOptions): JSX.Element {
  const [docTitle, setDocTitle] = useState<string | null>(null)
  const [api] = useState<AppApi>(() => createAirshipApi(meta.id, { onWindowTitle: setDocTitle }))
  // 只读：应用不能改主题，但必须把主题画出来
  useTheme()

  /**
   * 画完就报就绪。截图模式按这条决定什么时候按下快门——
   * 截出一张加载占位看着像跑起来了，其实什么都没验。
   */
  useEffect(() => {
    document.documentElement.dataset.airshipMounted = meta.id
  }, [meta.id])
  useReportShotReady([meta.id])

  return (
    <div className="app-window">
      <Titlebar
        here={meta.name}
        center={docTitle}
        icon={icon ? <img src={icon} alt="" className="titlebar__app-glyph" /> : undefined}
      />
      <div className={`app-window__body${meta.flush === true ? ' app-window__body--flush' : ''}`}>
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
