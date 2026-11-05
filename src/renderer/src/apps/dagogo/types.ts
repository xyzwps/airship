/** 数据模型与 Expo 版完全一致，导出文件互通。 */
export type Task = {
  id: string
  title: string
  createdAt: string
  completedAt: string | null
}

export type TaskFile = {
  version: 1
  tasks: Task[]
}

export type ExportFile = TaskFile & {
  app: '打勾勾'
  exportedAt: string
}

export const DEFAULT_ENCOURAGEMENT = '一件一件，慢慢来'

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isTask(value: unknown): value is Task {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.completedAt === null || typeof value.completedAt === 'string')
  )
}

/**
 * 导入归一化。和 Expo 版同一套规则：
 * 接受裸数组或 { tasks: [] }；跳过非法项和空标题；
 * id 缺失或重复时重新生成，避免主键冲突把整份数据卡死。
 */
export function normalizeImportedTasks(value: unknown): Task[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tasks)
      ? value.tasks
      : null

  if (!source) throw new Error('文件不是打勾勾的 JSON 数据')

  const seen = new Set<string>()
  const tasks: Task[] = []

  for (const item of source) {
    if (!isTask(item)) continue
    const title = item.title.trim()
    if (!title) continue

    let id = item.id
    while (!id || seen.has(id)) id = createId()
    seen.add(id)

    tasks.push({ ...item, id, title })
  }

  if (tasks.length === 0) throw new Error('文件里没有可导入的待办')
  return tasks
}
