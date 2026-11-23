import type { AppMeta } from '@airship/contract'

/**
 * 应用清单：这个应用对外形状的全部。
 *
 * 只写"这个应用自己的事实"。图标是包根那一张文件（不进清单），
 * 显示顺序由 runtime 按名字典序定（也不是应用自己能决定的）。
 *
 * `name` 是标题栏念的显示名，手脚架先落成 id——改成你要念的话，中文随便。
 *
 * `capabilities` 是唯一授权面：没声明的一律拒绝。用到哪个域就在数组里加哪个名，
 * 例如想读写设置就加 'settings'。后台程序不在这里——旁边放一份 src/backend.ts 就有后台（约定）。
 */
export const app: AppMeta = {
  id: '__APP_ID__',
  name: '__APP_NAME__',
  description: '一句话说清这个应用是干什么的',
  capabilities: []
}
