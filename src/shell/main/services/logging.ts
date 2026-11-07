import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logDir } from './paths'
import type { AppId } from '@airship/contract'

type Level = 'info' | 'warn' | 'error'

const SHELL = 'shell'

function stamp(): string {
  return new Date().toISOString()
}

function dayFile(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return join(logDir(), `airship-${y}-${m}-${day}.log`)
}

function write(level: Level, source: AppId | typeof SHELL, message: string, detail?: unknown): void {
  let line = `${stamp()} ${level.toUpperCase().padEnd(5)} [${source}] ${message}`
  if (detail !== undefined) {
    try {
      const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
      // 单行化，避免日志里出现断行的 JSON
      line += ' ' + text.replace(/\r?\n/g, ' ⏎ ').slice(0, 4000)
    } catch {
      line += ' [unserializable detail]'
    }
  }
  try {
    mkdirSync(logDir(), { recursive: true })
    appendFileSync(dayFile(), line + '\n', 'utf8')
  } catch {
    // 日志写不进去不能把应用带崩
  }
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (source: AppId | typeof SHELL, message: string, detail?: unknown) =>
    write('info', source, message, detail),
  warn: (source: AppId | typeof SHELL, message: string, detail?: unknown) =>
    write('warn', source, message, detail),
  error: (source: AppId | typeof SHELL, message: string, detail?: unknown) =>
    write('error', source, message, detail)
}
