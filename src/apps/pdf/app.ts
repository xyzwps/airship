import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'pdf',
  name: 'PDF',
  description: 'PDF 阅读，与墨读共用同一个书架',
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
}
