import { formatFileStamp } from './time'
import { isTask, normalizeImportedTasks, type ExportFile, type Task, type TaskFile } from './types'

/**
 * 后端的全部业务——纯函数，盘上的事都交给一张 io。
 *
 * `backend.ts` 用真文件系统喂它；用例把同一份 `handle` 接在替身的卷上跑，
 * 测的就是真后端的逻辑本身，不是另抄的一份。
 *
 * 对外的方法（渲染侧 storage.ts 是唯一说话人）：
 *   load                → Task[]            数据文件没有就是空表；形状不对喊「本地数据格式不正确」
 *   save   {tasks}                            整份重写 dagogo.json（与手机版逐字兼容的形状）
 *   export {tasks, target} → 落盘的文件名     导出的四键结构与手机版互读
 *   import {path}        → Task[]            裸数组与 {tasks:[…]} 两种都收
 *   setBackground {source} → 存进去的文件名   选来的图拷进数据目录
 *   clearBackground {fileName}                只认自家前缀，别的不动
 *   backgroundUrl {fileName} → file:/// URL   渲染侧拿去当背景
 */

const DATA_FILE = 'dagogo.json'
const BACKGROUND_PREFIX = 'background-'

/** 后端要碰盘的那几件事——真后端一份 node:fs 的，用例一份内存的 */
export interface BackendIo {
  /** 数据目录里那个名字的绝对路径 */
  dataPath(name: string): string
  /** 读不出来就 null——"没有这个文件"与"读不到"在这一层不区分 */
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  copyFile(source: string, target: string): Promise<void>
  removeFile(path: string): Promise<void>
}

function serialize(file: TaskFile | ExportFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/** 只有字母数字的 2–5 位扩展名才配进文件名；jpeg 收成 jpg，认不出一律 jpg */
function imageExtension(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (/^[a-z0-9]{2,5}$/.test(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'jpg'
}

/** 数据文件里那份列表：形状不对就说不对，不猜、不静默清空 */
async function readTasks(io: BackendIo): Promise<Task[]> {
  const text = await io.readText(io.dataPath(DATA_FILE))
  if (text === null) return []

  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as TaskFile).tasks)) {
    throw new Error('本地数据格式不正确')
  }
  return (parsed as TaskFile).tasks.filter(isTask)
}

const handlers: Record<string, (payload: any, io: BackendIo) => unknown | Promise<unknown>> = {
  load: (_p, io) => readTasks(io),

  save: async ({ tasks }, io) => {
    await io.writeText(io.dataPath(DATA_FILE), serialize({ version: 1, tasks: tasks as Task[] }))
    return null
  },

  export: async ({ tasks, target }, io) => {
    const now = new Date()
    const file: ExportFile = {
      app: '打勾勾',
      version: 1,
      exportedAt: now.toISOString(),
      tasks: tasks as Task[]
    }
    await io.writeText(target, serialize(file))
    return target.split(/[\\/]/).pop() ?? `dagogo-${formatFileStamp(now)}.json`
  },

  import: async ({ path }, io) => {
    const text = await io.readText(path)
    if (text === null) throw new Error('读不到或已经不存在这个文件')
    return normalizeImportedTasks(JSON.parse(text))
  },

  setBackground: async ({ source }, io) => {
    const fileName = `${BACKGROUND_PREFIX}${Date.now()}.${imageExtension(source)}`
    await io.copyFile(source, io.dataPath(fileName))
    return fileName
  },

  clearBackground: async ({ fileName }, io) => {
    // 只删自家前缀的；别的名字哪怕真在目录里也不碰。删不动就当作没这回事
    if (typeof fileName !== 'string' || !fileName.startsWith(BACKGROUND_PREFIX)) return null
    await io.removeFile(io.dataPath(fileName)).catch(() => undefined)
    return null
  },

  backgroundUrl: ({ fileName }, io) => {
    if (typeof fileName !== 'string' || fileName === '') return null
    // Windows 的反斜杠路径换成 file:///C:/… 的形式
    const normalized = io.dataPath(fileName).replace(/\\/g, '/')
    return `file:///${normalized.replace(/^\/+/, '')}`
  }
}

/** 一次调用。回给人听的永远是人话——方法不认或盘上的事炸了，都让异常消息原样上界面 */
export async function handle(method: string, payload: unknown, io: BackendIo): Promise<unknown> {
  const handler = handlers[method]
  if (!handler) throw new Error(`后端不认的方法：${method}`)
  return handler(payload ?? {}, io)
}
