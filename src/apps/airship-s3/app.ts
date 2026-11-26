import type { AppMeta } from '@airship/contract'

/**
 * S3：对象存储的界面。
 *
 * 网络与磁盘的事全在包自带的后台进程里（`backend.ts`，随包归档的约定，不是能力位）：
 * 窗口既不发请求也不碰盘，所以 2026-11-24 起这份清单不再有 `net` 与 fs 的两档——
 * 那条能力位连同它的 CSP 档与同源豁免整族退场（注记见 app-model.md 与 bridge.md 末尾）。
 *
 * `dialog` 只服务于"让用户挑一个本机路径"（上传来源、下载落点、建目录的选图没有）；
 * 字节由后端进程自己按那个路径读写。`clipboard` 服务于复制临时链接，
 * `settings` 存那一份源列表。
 */
export const app: AppMeta = {
  id: 'airship-s3',
  name: 'S3',
  description: '连着 S3 兼容的对象存储看桶与对象：浏览、上传、下载、预览、删除、复制临时链接',
  capabilities: ['settings', 'dialog', 'clipboard'],
  // 自己铺满整窗：顶栏、左栏、表格各有各的内边距，宿主再给一圈留白就是窗内那道白边
  flush: true,
  defaultWidth: 1180,
  defaultHeight: 760
}
