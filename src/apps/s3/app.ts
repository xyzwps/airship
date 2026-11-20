import type { AppMeta } from '@airship/contract'

/**
 * S3：对象存储的界面。
 *
 * `net` 是这一家独有的那一档能力——它在自己窗口里直连用户填进去的端点，
 * 不经过 runtime 代发。判据见 `src/runtime/specs/bridge.md` BR-011 与 `src/apps/specs/app-model.md` AP-017。
 *
 * `fs.read` / `fs.write` 只服务于"选中本地文件上传"与"把对象存到本地"这两件事：
 * 路径一律来自系统对话框，应用自己写不出一个路径来。
 * 拖进来松手那一族不在这两条之内——字节从那颗文件自己身上分段读，不经本机路径，也用不到 `fs`。
 * `clipboard` 服务于复制临时链接。
 */
export const app: AppMeta = {
  id: 's3',
  name: 'S3',
  description: '连着 S3 兼容的对象存储看桶与对象：浏览、上传、下载、预览、删除、复制临时链接',
  capabilities: ['net', 'settings', 'dialog', 'fs.read', 'fs.write', 'clipboard'],
  // 自己铺满整窗：顶栏、左栏、表格各有各的内边距，宿主再给一圈留白就是窗内那道白边
  flush: true,
  defaultWidth: 1180,
  defaultHeight: 760
}
