import type { AppId } from '@shared/protocol'
import type { AppApi } from '../shell/useAppApi'

/**
 * 应用入口约定。
 *
 * 每个应用就是一个 React 组件，拿到已绑定身份的 api，自己管自己的状态。
 * flush=true 表示这个应用要占满整个内容区、不要壳给的 22/26 内边距
 * （阅读器这种要自己控制版心的用得上）。
 *
 * 以后拆插件系统时，这里从"静态 import"换成"按 manifest 动态加载 + iframe 承载"，
 * 应用自己的代码一行不用改——这就是为什么入口签名现在就定死。
 */
export interface AppEntry {
  component: React.ComponentType<{ api: AppApi }>
  /** 内容区是否去掉默认内边距 */
  flush?: boolean
}

export function isAppId(value: string | null): value is AppId {
  return value === 'vcp' || value === 'books' || value === 'pdf' || value === 'dagogo'
}
