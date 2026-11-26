/**
 * 找装好的 runtime：顺序与安装器完全一致（PK-031 那一条）——
 * `AIRSHIP_PATH` 指着的目录优先，其次固定落点 `~\.airship\runtime`（当前用户主目录）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const RUNTIME_EXE = 'airship.exe'

export function findRuntime() {
  const fromEnv = process.env.AIRSHIP_PATH
  if (fromEnv && existsSync(join(fromEnv, RUNTIME_EXE))) return join(fromEnv, RUNTIME_EXE)
  // 固定落点：`~/.airship/runtime`，与 build/installer.nsh 的 customInit 同一处
  const fixed = join(homedir(), '.airship', 'runtime')
  if (existsSync(join(fixed, RUNTIME_EXE))) return join(fixed, RUNTIME_EXE)
  throw new Error(
    `找不到 airship runtime：先装 runtime（固定装在 ${fixed}），` + `或把 AIRSHIP_PATH 指到它所在的目录。`
  )
}
