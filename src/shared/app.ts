import type { Capability, SharedNamespace } from './protocol'

/**
 * 应用清单里的**纯数据**部分。
 *
 * 单独一个文件、不带任何组件引用，是有意的：主进程也要读它做能力校验和
 * 目录布局，而主进程不该 import 任何渲染侧代码。所以约定是——
 *
 *   apps/<id>/app.ts     导出 `app: AppMeta`（纯数据，两侧都能读）
 *   apps/<id>/index.tsx  默认导出组件（只有渲染进程读）
 *
 * 组件不进清单类型：它由壳按目录约定去解析，应用不用在清单里写路径。
 */
export interface AppMeta {
  /** 唯一 id，同时是它在 userData 下的数据目录名 */
  id: string
  /** 界面显示名 */
  name: string
  /** 一句话说清它是干什么的 */
  description: string
  /** 侧栏/卡片图标：24x24 视图框内的 SVG path 数据 */
  iconPath: string
  /** 强调色，用于侧栏选中态与图标着色 */
  accent: string
  /** 声明式权限。没写的一律拒绝，且抛可读原因 */
  capabilities: Capability[]
  /** 要访问的壳托管共享命名空间；必须含 'shared' 能力才有意义 */
  sharedNamespaces?: SharedNamespace[]
  /** 内容区是否去掉壳给的默认内边距（要自己控制版心的应用用） */
  flush?: boolean
  /** 侧栏显示顺序，小的在前；不写就排在最后按名字。壳不维护顺序表 */
  order?: number
}
