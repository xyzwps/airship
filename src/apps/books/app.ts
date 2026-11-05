import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'books',
  name: '墨读',
  description: 'EPUB / MOBI / TXT 电子书书架与阅读器',
  // 一本摊开的书
  iconPath:
    'M12 6.5C10.5 5 8 4.2 4 4.2v13.4c4 0 6.5.8 8 2.3 1.5-1.5 4-2.3 8-2.3V4.2c-4 0-6.5.8-8 2.3z M12 6.5v13.4',
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
  order: 2
}
