import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'dagogo',
  name: '打勾勾',
  description: '每天要做的事，勾掉就行',
  // 一个勾
  iconPath: 'M4 12.5l5 5L20 6.5',
  accent: '#7a7fbf',
  capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'tray', 'notify', 'log'],
  flush: true,
  order: 4
}
