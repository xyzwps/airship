import type { AppApi } from '@airship/contract'
import { formatFileStamp } from './time'
import type { Task } from './types'

/**
 * 存储层——只剩薄皮，盘上的事都在应用自带的后端里（`backend.ts`）。
 *
 * 这里还归渲染进程管的只有两样：只有渲染进程碰得到的系统对话框（选位置、选文件），
 * 和把选来的路径交给后端去处理。清单因此不再要 fs.read / fs.write。
 *
 * 连续勾选时后一次写不再可能盖掉前一次：后端按消息到的顺序逐条处理，
 * 从前在渲染侧压着顺序的那条串行队列随之下岗。
 */

export function loadTasks(api: AppApi): Promise<Task[]> {
  return api.backend.invoke<Task[]>('load')
}

export function saveTasks(api: AppApi, tasks: Task[]): Promise<void> {
  return api.backend.invoke<void>('save', { tasks })
}

/** 导出到用户选的位置。返回文件名；用户取消返回 null。 */
export async function exportToFile(api: AppApi, tasks: Task[]): Promise<string | null> {
  const target = await api.dialog.saveFile({
    title: '导出打勾勾数据',
    defaultPath: `dagogo-${formatFileStamp(new Date())}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!target) return null
  return api.backend.invoke<string>('export', { tasks, target })
}

/** 从用户选的 JSON 导入。取消返回 null。 */
export async function importFromFile(api: AppApi): Promise<Task[] | null> {
  const picked = await api.dialog.openFiles({
    title: '选择打勾勾的 JSON 数据',
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!picked || picked.length === 0) return null
  return api.backend.invoke<Task[]>('import', { path: picked[0]! })
}

/* ---------- 背景图 ---------- */

/** 选一张图交给后端拷进应用数据目录，返回存进去的文件名。取消返回 null。 */
export async function pickBackground(api: AppApi): Promise<string | null> {
  const picked = await api.dialog.openFiles({
    title: '选择背景图',
    multiple: false,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (!picked || picked.length === 0) return null
  return api.backend.invoke<string>('setBackground', { source: picked[0]! })
}

export function deleteBackground(api: AppApi, fileName: string | null): Promise<void> {
  if (!fileName) return Promise.resolve()
  return api.backend.invoke<void>('clearBackground', { fileName }).then(() => undefined)
}

/** 把存进去的文件名变成后端给的回显 URL（file:/// + 绝对路径） */
export function backgroundUrl(api: AppApi, fileName: string | null): Promise<string | null> {
  if (!fileName) return Promise.resolve(null)
  return api.backend.invoke<string | null>('backgroundUrl', { fileName })
}
