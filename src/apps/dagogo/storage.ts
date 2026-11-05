import type { AppApi } from '@shared/protocol'
import { formatFileStamp } from './time'
import { isTask, normalizeImportedTasks, type ExportFile, type Task, type TaskFile } from './types'

/**
 * 存储层。
 *
 * 数据落在应用自己的 data 目录（dagogo.json），不再像 Expo 版那样
 * 自己维护 documentDirectory 路径——壳已经把目录分好了。
 *
 * 写盘走串行队列：连续勾选时后一次写不能把前一次覆盖掉，
 * Expo 版踩过这个坑，这里保留同样的做法。
 */

const DATA_FILE = 'dagogo.json'

let writeQueue: Promise<void> = Promise.resolve()

function serialize(file: TaskFile | ExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

function dataPath(api: AppApi): Promise<string> {
  return api.fs.resolveInData(DATA_FILE)
}

export async function loadTasks(api: AppApi): Promise<Task[]> {
  const path = await dataPath(api)
  const stat = await api.fs.stat(path)
  if (!stat) return []

  const bytes = await api.fs.read(path)
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes))

  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as TaskFile).tasks)) {
    throw new Error('本地数据格式不正确')
  }
  return (parsed as TaskFile).tasks.filter(isTask)
}

export function saveTasks(api: AppApi, tasks: Task[]): Promise<void> {
  const pending = writeQueue
    .catch(() => undefined)
    .then(async () => {
      const path = await dataPath(api)
      await api.fs.write(path, serialize({ version: 1, tasks }))
    })
  writeQueue = pending.catch(() => undefined)
  return pending
}

/** 导出到用户选的位置。返回文件名；用户取消返回 null。 */
export async function exportToFile(api: AppApi, tasks: Task[]): Promise<string | null> {
  const now = new Date()
  const fileName = `dagogo-${formatFileStamp(now)}.json`
  const file: ExportFile = {
    app: '打勾勾',
    version: 1,
    exportedAt: now.toISOString(),
    tasks
  }

  const target = await api.dialog.saveFile({
    title: '导出打勾勾数据',
    defaultPath: fileName,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!target) return null

  await api.fs.write(target, serialize(file))
  return target.split(/[\\/]/).pop() ?? fileName
}

/** 从用户选的 JSON 导入。取消返回 null。 */
export async function importFromFile(api: AppApi): Promise<Task[] | null> {
  const picked = await api.dialog.openFiles({
    title: '选择打勾勾的 JSON 数据',
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }]
  })
  if (!picked || picked.length === 0) return null

  const bytes = await api.fs.read(picked[0]!)
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8').decode(bytes))
  return normalizeImportedTasks(parsed)
}

/* ---------- 背景图 ---------- */

const BACKGROUND_PREFIX = 'background-'

function imageExtension(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (/^[a-z0-9]{2,5}$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'jpg'
}

/** 选一张图拷进应用数据目录，返回存进去的文件名。取消返回 null。 */
export async function pickBackground(api: AppApi): Promise<string | null> {
  const picked = await api.dialog.openFiles({
    title: '选择背景图',
    multiple: false,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
  })
  if (!picked || picked.length === 0) return null

  const source = picked[0]!
  const fileName = `${BACKGROUND_PREFIX}${Date.now()}.${imageExtension(source)}`
  const dest = await api.fs.resolveInData(fileName)
  await api.fs.copy(source, dest)
  return fileName
}

export async function deleteBackground(api: AppApi, fileName: string | null): Promise<void> {
  if (!fileName || !fileName.startsWith(BACKGROUND_PREFIX)) return
  const path = await api.fs.resolveInData(fileName)
  await api.fs.remove(path).catch(() => undefined)
}

/** 把存进去的文件名变成能显示的路径（file:// + 绝对路径） */
export async function backgroundUrl(api: AppApi, fileName: string | null): Promise<string | null> {
  if (!fileName) return null
  const path = await api.fs.resolveInData(fileName)
  // Windows 路径要转成 file:///C:/... 的形式
  const normalized = path.replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\/+/, '')}`
}
