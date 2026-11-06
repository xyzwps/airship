import type { Capability, PlatformId, SharedNamespace, ToolName } from './protocol'

/**
 * 应用清单里的**纯数据**部分。
 *
 * 单独一个文件、不带任何组件引用，是有意的：主进程也要读它做能力校验和
 * 目录布局，而主进程不该 import 任何渲染侧代码。所以约定是——
 *
 *   apps/<id>/app.ts     导出 `app: AppMeta`（纯数据，两侧都能读）
 *   apps/<id>/index.tsx  默认导出组件，壳按目录约定解析
 *   apps/<id>/icon.*     图标文件约定，有且只有一张
 *
 * 图标**不在这里**：它是表现层的东西，而且形式不该被限死——
 * 可能是多条 path，可能是 circle/rect/渐变，也可能就是一张位图。
 * 清单里写 `iconPath: string` 等于假定"图标必须是单条 path 的 SVG"，两个假定都错。
 */

export interface AppMeta {
  /** 唯一 id，同时是它在 userData 下的数据目录名 */
  id: string
  /** 界面显示名 */
  name: string
  /** 一句话说清它是干什么的 */
  description: string
  /** 声明式权限。没写的一律拒绝，且抛可读原因 */
  capabilities: Capability[]
  /** 要访问的壳托管共享命名空间；必须含 'shared' 能力才有意义 */
  sharedNamespaces?: SharedNamespace[]
  /** 内容区是否去掉壳给的默认内边距（要自己控制版心的应用用） */
  flush?: boolean
  /**
   * 这个应用窗口的尺寸。**不写就用壳的默认（1100×740）**，两个字段各自独立：
   * 只写宽度就是宽度自定、高度跟壳。
   *
   * 这是应用自身的事实：容器台是两栏表格、打勾勾是一列清单，最佳版心宽度本来就不一样，
   * 让壳去猜每个应用的版式等于壳替应用做决定。
   *
   * 壳**不记窗口状态**（尺寸与位置都不记），所以改这两个数立刻生效，也不需要先清掉什么记忆
   * ——判据见 `src/shell/specs/shell.md` SH-015 / SH-016 / SH-018。
   */
  defaultWidth?: number
  defaultHeight?: number
  /**
   * 只在这些平台上可用。**不写 = 全平台**，写了 = 只有列出的平台算可用。
   *
   * 这是应用自身的事实，不是壳的表现决定：依赖 `wslc.exe` 的东西在别的环境上
   * 根本跑不起来，藏在格子里点开了只会给用户一句错误。
   * 壳按它过滤启动器的格子，并在有人硬开这个应用时拒绝（措辞见 shared/errors.ts）。
   */
  platforms?: PlatformId[]
  /**
   * 这个应用要用的外部工具（壳的工具表里的名字）。
   * 声明了才拿得到路径，也只有这些路径能进 proc 白名单。
   */
  tools?: ToolName[]
}
