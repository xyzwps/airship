import type { AppMeta } from '@airship/contract'

export const app: AppMeta = {
  id: 'airship-reader',
  name: 'Reader',
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
  // runtime 级共享书库：书架、导入、封面、进度都存那一份
  sharedNamespaces: ['library'],
  flush: true,
  defaultWidth: 600,
  defaultHeight: 800,
}
