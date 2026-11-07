import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  id: 'books',
  name: '墨读',
  description: 'EPUB / MOBI 电子书书架与阅读器',
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
  defaultWidth: 600,
  defaultHeight: 800,
}
