/**
 * 渲染侧的显示与本地校验——从前散在 `client.ts` 与 `transfer.ts` 里，
 * 那两族随网络层搬进了后端进程，这些留在窗口这一侧的收进这一份。
 *
 * 这里没有一处网络、也没有一处盘：全是"这句话怎么说、这个名字行不行"。
 * 措辞是契约的一部分（册子钉的就是这几句），所以它们在这里、不在组件里。
 */

/** 服务端一次复制的上限：5 GB（S3 的 CopyObject 契约，兼容端点照抄） */
export const COPY_SOURCE_LIMIT = 5 * 1024 * 1024 * 1024

/** 超过一次复制上限时界面念的那句：两个数都要在场（判据 OS-049） */
export function copyTooBigText(bytes: number): string {
  return `这个对象有 ${formatSize(bytes)}，超过服务端一次复制的 5 GB，改不了`
}

/**
 * 新建桶时先在本地判这几条，判出来的原因要能读。
 *
 * 只收**不含句点**的名字：这样 S3 那侧关于句点的几条规矩（不能相邻、不能是 IP 形式）
 * 根本用不上，也就不需要在这里复述一遍别家的规范。
 * 剩下的规矩（区域特有的长度、保留名）交给端点，它拒了就把它的原话念出来。
 * 返回空串就是合格。
 */
export function validateBucketName(name: string): string {
  if (name === '') return '桶名是空的'
  if (name.length < 3 || name.length > 63) return `桶名要 3 到 63 个字符，现在 ${name.length} 个`
  if (!/^[a-z0-9-]+$/.test(name)) return '桶名只能用小写字母、数字与连字符'
  if (!/^[a-z0-9]/.test(name) || !/[a-z0-9]$/.test(name)) return '桶名首尾要是字母或数字'
  return ''
}

/**
 * 新建目录时先在本地判这几条。
 *
 * 目录名就是键里的一段，所以只判"这一段自己"的规矩：带斜杠等于一次建好几层，
 * 那不是这颗键该做的事。同名那一档比的是**当前这一层里已经列出来的目录行**，
 * 端点侧没有"目录已存在"这种拒绝——它只会把那个零字节标记再存一遍。
 * 返回空串就是合格。
 */
export function validateDirName(name: string, siblings: string[]): string {
  if (name === '') return '目录名是空的'
  if (name.includes('/')) return '目录名里不要带斜杠，一次建一层'
  if (siblings.includes(name)) return `这一层里已经有叫 ${name} 的目录`
  return ''
}

/**
 * 重命名对象时先在本地判这几条。
 *
 * 新名字就是键在当前这一层里的那一段，所以斜杠那一档与建目录同规矩。
 * 同名那一档比的是**当前这一层里已经列出来的对象行**（不含自己）——
 * 端点对 CopyObject 没有"目标已存在就拒"这一说，它会直接盖上去，所以只能在动手之前拦。
 * 名字没改也拦下来：转一圈复制再删掉、端点上什么都没变，那一趟不值得走。
 * 返回空串就是合格。
 */
export function validateRename(name: string, currentName: string, siblings: string[]): string {
  if (name === '') return '新名字是空的'
  if (name.includes('/')) return '新名字里不要带斜杠，一次只改这一层的名字'
  if (name === currentName) return '名字没变，什么都没动'
  if (siblings.includes(name)) return `这一层里已经有叫 ${name} 的对象`
  return ''
}

/** 人读的大小：整块存储的字节数在界面上念成一串数字没人看得懂 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1)
  return `${text} ${units[unit]}`
}

/** 人读的时间：只到分钟，秒在文件列表里没意义 */
export function formatTime(iso: string): string {
  if (iso === '') return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 上传时要写进对象的内容类型。
 *
 * 只认这一小张表：认不出的一律 `application/octet-stream`，
 * 那正是 S3 自己的默认值——猜一个 `text/plain` 反而会把二进制文件在浏览器里打开成乱码。
 */
const TYPES: Record<string, string> = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf'
}

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'application/octet-stream'
  return TYPES[name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream'
}

/** 键与本地文件名之间的那道拼接：当前前缀 + 文件名，斜杠不重复 */
export function joinKey(prefix: string, fileName: string): string {
  return prefix === '' ? fileName : `${prefix}${fileName}`
}
