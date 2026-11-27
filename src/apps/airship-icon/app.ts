import type { AppMeta } from '@airship/contract'

/**
 * 应用清单：这个应用对外形状的全部。
 *
 * 只写"这个应用自己的事实"。`iconPath`、`order` 与"记住上次尺寸"这类字段都被驳回过——
 * 图标是包根那一张文件，顺序由 runtime 按名字典序定（判据见 src/apps/specs/app-model.md）。
 */
export const app: AppMeta = {
  name: 'Icon Helper',
  description: '给一份 SVG，出符合 docs/apps/icons.md 的 icon.png 与 7 帧 icon.ico',
  // dialog 问落点与选文件，fs.read 读那份 SVG，fs.write 写这两张产物（落点由 saveFile 给）
  defaultWidth: 720,
  defaultHeight: 780
}
