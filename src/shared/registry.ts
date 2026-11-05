import {
  SHARED_NAMESPACES,
  type AppId,
  type Capability,
  type SharedNamespace
} from './protocol'

/**
 * 应用登记表——数据部分。
 *
 * 主进程用它做能力校验，渲染进程用它列侧栏。
 * React 组件不在这里（主进程不该碰到 tsx），组件在 renderer/src/apps/index.ts 里按 id 对应。
 *
 * capabilities 是应用主动声明的，多写不会多给：主进程按这张表放行，
 * 表里没有的一律拒。加新能力要同时改 protocol.ts 的 Capability 和 ipc.ts 的实现。
 */

export interface AppMeta {
  id: AppId
  /** 界面上显示的名字 */
  name: string
  /** 一句话说清它是干什么的 */
  description: string
  /** 侧栏图标，内联 SVG 的 path 数据（24x24 视图框） */
  iconPath: string
  capabilities: Capability[]
  /** 可访问的壳级共享命名空间，必须是 capabilities 里含 'shared' 才有意义 */
  sharedNamespaces?: SharedNamespace[]
  /** 主题色，用于侧栏选中态和标题栏点缀 */
  accent: string
}

export const APPS: AppMeta[] = [
  {
    id: 'vcp',
    name: 'vcp',
    description: 'FFmpeg 编排台：选流、加处理链、看命令、跑队列',
    // 一个方块被斜切成两段，代表转码前后
    iconPath: 'M3 4h18v16H3z M3 4l18 16 M9 4v16 M15 4v16',
    capabilities: [
      'fs.read',
      'fs.write',
      'dialog',
      'settings',
      'proc',
      'notify',
      'clipboard',
      'log'
    ],
    accent: '#e0834a'
  },
  {
    id: 'books',
    name: '墨读',
    description: 'EPUB / MOBI / TXT 电子书书架与阅读器',
    // 一本摊开的书
    iconPath:
      'M12 6.5C10.5 5 8 4.2 4 4.2v13.4c4 0 6.5.8 8 2.3 1.5-1.5 4-2.3 8-2.3V4.2c-4 0-6.5.8-8 2.3z M12 6.5v13.4',
    capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'shared', 'notify', 'clipboard', 'log'],
    sharedNamespaces: ['library'],
    accent: '#5b8c7b'
  },
  {
    id: 'pdf',
    name: 'PDF',
    description: 'PDF 阅读，与墨读共用同一个书架',
    // 一页纸带折角
    iconPath: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
    capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'shared', 'notify', 'clipboard', 'log'],
    sharedNamespaces: ['library'],
    accent: '#b3564e'
  },
  {
    id: 'dagogo',
    name: '打勾勾',
    description: '每天要做的事，勾掉就行',
    // 一个勾
    iconPath: 'M4 12.5l5 5L20 6.5',
    capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'tray', 'notify', 'log'],
    accent: '#7a7fbf'
  }
]

export const APP_MAP: Record<AppId, AppMeta> = APPS.reduce(
  (acc, meta) => {
    acc[meta.id] = meta
    return acc
  },
  {} as Record<AppId, AppMeta>
)

export function capabilitiesOf(app: AppId): readonly Capability[] {
  return APP_MAP[app]?.capabilities ?? []
}

export function hasCapability(app: AppId, capability: Capability): boolean {
  return capabilitiesOf(app).includes(capability)
}

/** 应用能不能碰某个共享命名空间：既要有 shared 能力，也要在名单里 */
export function canAccessShared(app: AppId, ns: string): boolean {
  if (!hasCapability(app, 'shared')) return false
  if (!(SHARED_NAMESPACES as readonly string[]).includes(ns)) return false
  return (APP_MAP[app]?.sharedNamespaces ?? []).includes(ns as SharedNamespace)
}
