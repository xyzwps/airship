import { lazy } from 'react'
import type { AppId } from '@shared/protocol'
import type { AppEntry } from './types'

/**
 * 应用注册表（渲染侧）。
 *
 * 用 React.lazy 分开打包：每个应用一个 chunk，互不影响首屏，
 * 也为后续"按 manifest 动态加载"留好了形状——那时只是把 lazy() 的参数
 * 从静态 import 换成按路径解析。
 */
export const APP_ENTRIES: Record<AppId, AppEntry> = {
  vcp: {
    component: lazy(() => import('./vcp/VcpApp')),
    flush: true
  },
  books: {
    component: lazy(() => import('./books/BooksApp')),
    flush: true
  },
  pdf: {
    component: lazy(() => import('./pdf/PdfApp')),
    flush: true
  },
  dagogo: {
    component: lazy(() => import('./dagogo/DagogoApp')),
    flush: true
  }
}
