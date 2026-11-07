import type { AppMeta } from './app.ts'
import { APP_ID_PATTERN } from './app.ts'
import { badAppId, unknownTool } from './errors.ts'
import { PLATFORM_IDS, TOOL_NAMES } from './protocol.ts'

/**
 * 应用注册表的规矩（两侧共用一份）。
 *
 * 主进程与渲染侧各自 glob 出同一批清单，如果各写一套校验，就会出现
 * "一侧收下了、另一侧炸了"的分裂。规矩只有这些条，写在一处，测在一处。
 * 返回值是**人读的原因列表**——注册期直接炸，比运行到一半"能力查不到"好解释得多。
 */

/** 清单本身的规矩：id 与目录名一致、字段合法、id 不重复 */
export function manifestProblems(
  file: string,
  dirId: string,
  meta: AppMeta | undefined,
  seen: readonly string[]
): string[] {
  if (!meta) return [`${file}: 没导出 app`]
  const out: string[] = []
  // 先判形状再判一致：id 写成「墨读」时，"与目录名不一致"是最没用的那句
  if (!APP_ID_PATTERN.test(meta.id)) out.push(`${file}: ${badAppId(meta.id)}`)
  if (meta.id !== dirId) out.push(`${file}: 清单 id "${meta.id}" 与目录名 "${dirId}" 不一致`)
  if (seen.includes(meta.id)) out.push(`${file}: id 重复 "${meta.id}"`)
  for (const tool of meta.tools ?? []) {
    if (!(TOOL_NAMES as readonly string[]).includes(tool)) out.push(`${file}: ${unknownTool(meta.id, tool)}`)
  }
  for (const p of meta.platforms ?? []) {
    if (!(PLATFORM_IDS as readonly string[]).includes(p)) {
      out.push(`${file}: 不认识的平台 "${p}"（清单 platforms 只认 ${PLATFORM_IDS.join(' / ')}）`)
    }
  }
  for (const key of ['defaultWidth', 'defaultHeight'] as const) {
    const v = meta[key]
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
      out.push(`${file}: 清单 ${key} 必须是正整数像素值，收到 ${JSON.stringify(v)}`)
    }
  }
  return out
}

/**
 * 图标是文件约定：一张，也不能没有。
 *
 * 组件入口那一条判据原来也在这里（"缺 index.tsx"），随着构建期 glob 一起退场了：
 * 现在入口文档是包的一部分，缺不缺由产包器与运行期扫包各自喊一次
 * （`code/pack-app.mjs` 的 `layoutProblems`、`services/packageRegistry.ts`）。
 */
export function iconProblems(id: string, iconKeys: readonly string[]): string[] {
  if (iconKeys.length === 0) {
    return [`${id}: 缺图标 apps/${id}/icon.svg（也接受 png / jpg / jpeg / webp）`]
  }
  if (iconKeys.length > 1) {
    return [`${id}: 图标有多张，只留一张：${iconKeys.join(', ')}`]
  }
  return []
}

/**
 * 组件入口那一条判据原来也在这里（"缺 index.tsx"），随着构建期 glob 一起退场了：
 * 入口文档现在是包的一部分，缺不缺由产包器与运行期扫包各自喊一次
 * （`code/pack-app.mjs` 的 `layoutProblems`、`services/packageRegistry.ts`）。
 */
