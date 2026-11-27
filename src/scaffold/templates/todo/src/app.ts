import type { AppMeta } from '@airship/contract'

/**
 * 应用清单：这个应用对外形状的全部。
 *
 * 后台不在清单里：旁边放一份 `backend.ts`（或 `backend.js`）就有后台——约定，不是授权。
 * 产包流水把它编成包根那份 `backend.js`，runtime 在包里看到那个条目才起进程。
 */
export const app: AppMeta = {
  name: '__APP_NAME__',
  description: '数据由随包自带的后端写进磁盘 JSON 的待办清单',
  capabilities: []
}
