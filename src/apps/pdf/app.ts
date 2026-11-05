import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'pdf',
  name: 'PDF',
  description: 'PDF 阅读，与墨读共用同一个书架',
  // 一页纸带折角
  iconPath: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6 M9 16h6',
  accent: '#b3564e',
  capabilities: [
    'fs.read',
    'fs.write',
    'dialog',
    'settings',
    'shared',
    'notify',
    'clipboard',
    'log'
  ],
  sharedNamespaces: ['library'],
  flush: true,
  order: 3
}
