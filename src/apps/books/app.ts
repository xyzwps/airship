import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'books',
  name: '墨读',
  description: 'EPUB / MOBI / TXT 电子书书架与阅读器',
  accent: '#5b8c7b',
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
  // 与 pdf 应用共用同一份书库：书架、导入、封面、进度是同一套数据
  sharedNamespaces: ['library'],
  flush: true,
}
