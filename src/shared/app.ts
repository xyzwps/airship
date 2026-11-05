import type { Capability, SharedNamespace } from './protocol'

/**
 * 应用清单里的**纯数据**部分。
 *
 * 单独一个文件、不带任何组件引用，是有意的：主进程也要读它做能力校验和
 * 目录布局，而主进程不该 import 任何渲染侧代码。所以约定是——
 *
 *   apps/<id>/app.ts     导出 `app: AppMeta`（纯数据，两侧都能读）
 *   apps/<id>/index.tsx  默认导出组件，并导出 `icon`（只有渲染进程读）
 *
 * 图标**不在这里**：它是表现层的东西，而且形式不该被限死——
 * 可能是多条 path，可能是 circle/rect/渐变，也可能就是一张位图。
 * 清单里写 `iconPath: string` 等于假定"图标必须是单条 path 的 SVG"，两个假定都错。
 * 图标跟着组件住在 index.tsx，应用爱怎么画怎么画。
 */
export interface AppMeta {
  /** 唯一 id，同时是它在 userData 下的数据目录名 */
  id: string
  /** 界面显示名 */
  name: string
  /** 一句话说清它是干什么的 */
  description: string
  /** 强调色，用于图标底板着色与侧栏选中态 */
  accent: string
  /** 声明式权限。没写的一律拒绝，且抛可读原因 */
  capabilities: Capability[]
  /** 要访问的壳托管共享命名空间；必须含 'shared' 能力才有意义 */
  sharedNamespaces?: SharedNamespace[]
  /** 内容区是否去掉壳给的默认内边距（要自己控制版心的应用用） */
  flush?: boolean

}
