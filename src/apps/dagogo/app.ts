import type { AppMeta } from '@shared/app'

export const app: AppMeta = {
  id: 'dagogo',
  name: '打勾勾',
  description: '每天要做的事，勾掉就行',
  capabilities: ['fs.read', 'fs.write', 'dialog', 'settings', 'tray', 'notify', 'log'],
  flush: true,
}
