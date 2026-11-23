import type { AppMeta } from '@airship/contract'

/**
 * 应用清单：这个应用对外形状的全部。
 *
 * `capabilities: ['backend']` 与本文件的 `backend` 字段是一对：
 * 声明了 backend 能力就必须写入口路径，runtime 只在两者齐了以后才起那个进程。
 */
export const app: AppMeta = {
  id: '__APP_ID__',
  name: '__APP_NAME__',
  description: '数据由随包自带的后端写进磁盘 JSON 的待办清单',
  capabilities: ['backend'],
  backend: 'backend/index.js'
}
