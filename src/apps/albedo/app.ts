import type { AppMeta } from '@airship/contract'

/**
 * Albedo：SVG 编辑工作台。
 *
 * 能力面按"这个应用自己的事实"声明：
 *   settings —— 画布自动保存、语言、网格/吸附、最近字体，都存本应用命名空间；
 *   dialog + fs.read —— 导入 SVG、导入桌布图片、选择本机字体文件；
 *   fs.write —— 导出 SVG/PNG 落盘、把选中的字体文件复制进应用数据目录（跨会话再描轮廓要用）；
 *   clipboard —— 「复制 SVG」「复制 path d」。
 * 不声明网络、不声明 proc：这应用全部东西都在本地算。
 */
export const app: AppMeta = {
  id: 'albedo',
  name: 'Albedo',
  description: 'SVG 编辑工作台：形状与路径命令栈、布尔运算、对齐吸附、桌布描图、导出 SVG/PNG',
  capabilities: ['settings', 'dialog', 'fs.read', 'fs.write', 'clipboard'],
  flush: true,
  defaultWidth: 1440,
  defaultHeight: 900
}
