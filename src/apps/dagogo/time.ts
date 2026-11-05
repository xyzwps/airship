/** 时间格式化，与 Expo 版逐字一致，保证导入的老数据显示不变。 */
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatStamp(value: string, now: Date): string | null {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null

  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (isSameDay(date, now)) return clock
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

export function formatHeaderDate(date = new Date()): string {
  return `${date.getMonth() + 1}月${date.getDate()}日 · ${WEEKDAYS[date.getDay()]}`
}

export function formatTaskTimes(createdAt: string, completedAt: string | null): string {
  const now = new Date()
  const created = formatStamp(createdAt, now)
  const completed = completedAt ? formatStamp(completedAt, now) : null
  return [created ? `${created} 录入` : null, completed ? `${completed} 完成` : null]
    .filter(Boolean)
    .join(' · ')
}

export function formatFileStamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

export function isToday(iso: string): boolean {
  return isSameDay(new Date(iso), new Date())
}
