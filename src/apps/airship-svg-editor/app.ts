import type { AppMeta } from '@airship/contract'

/**
 * Albedo：SVG 编辑工作台。
 *
 * 清单只写这个应用自己的事实：
 *   画布自动保存、语言、网格/吸附、最近字体存本应用命名空间；
 *   导入 SVG / 桌布图片 / 本机字体走对话框，导出 SVG/PNG 与字体复制落盘；
 *   「复制 SVG」「复制 path d」用剪贴板。
 * 全部东西都在本地算，不碰外部程序。
 */
export const app: AppMeta = {
  name: 'SVG Editor',
  description: 'SVG 编辑工作台：形状与路径命令栈、布尔运算、对齐吸附、桌布描图、导出 SVG/PNG',
  flush: true,
  defaultWidth: 1440,
  defaultHeight: 900
}
