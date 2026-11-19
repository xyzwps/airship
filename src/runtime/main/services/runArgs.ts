import { resolve } from 'node:path'
import { PACKAGE_SUFFIX } from '@airship/contract'

/**
 * 从命令行里挑出包路径（纯函数，契约见 `src/runtime/specs/runtime.md` SH-030/031）。
 *
 * 只认 `.airship` 结尾的参数，别的（electron 自己的旗标、`--shot` 这类）一概跳过。
 * 相对路径按**交来这条命令行那一侧的 cwd** 解：首次启动是自己的 cwd，
 * 第二实例转发时 Electron 把对方的 cwd 一并交过来，就按对方的解——
 * 快捷方式给的是绝对路径，不受这条影响。
 */
export function archivesFromArgv(argv: readonly string[], cwd: string): string[] {
  return argv.filter((a) => a.endsWith(PACKAGE_SUFFIX)).map((a) => resolve(cwd, a))
}