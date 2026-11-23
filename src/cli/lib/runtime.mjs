/**
 * 找装好的 runtime：顺序与安装器完全一致（PK-031 那一条）——
 * `AIRSHIP_PATH` 指着的目录优先，其次固定落点 `C:\Program Files\airship\runtime`。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const RUNTIME_EXE = 'airship.exe'

export function findRuntime() {
  const fromEnv = process.env.AIRSHIP_PATH
  if (fromEnv && existsSync(join(fromEnv, RUNTIME_EXE))) return join(fromEnv, RUNTIME_EXE)
  const fixed = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'airship', 'runtime')
  if (existsSync(join(fixed, RUNTIME_EXE))) return join(fixed, RUNTIME_EXE)
  throw new Error(
    `找不到 airship runtime：先装 runtime（固定装在 C:\\Program Files\\airship\\runtime），` +
      `或把 AIRSHIP_PATH 指到它所在的目录。`
  )
}
