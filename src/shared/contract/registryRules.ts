import type { AppMeta } from './app.ts'
import { APP_ID_PATTERN } from './app.ts'
import { badAppId, unknownTool } from './errors.ts'
import { ICON_NAME, RETIRED_ICON_PATTERN } from './packageRules.ts'
import { PLATFORM_IDS, TOOL_NAMES } from './protocol.ts'

/**
 * 应用注册表的规矩（产包器与 runtime 注册共用一份）。
 *
 * 产包器与运行期注册各自校验同一份清单，如果各写一套校验，就会出现
 * "一侧收下了、另一侧炸了"的分裂。规矩只有这些条，写在一处，测在一处。
 * 返回值是**人读的原因列表**——注册期直接炸，比运行到一半"工具查不到"好解释得多。
 */

/** 清单本身的规矩：id 合形状、id 不重复、字段合法。id 由产包注入，这里不再与目录名对账 */
export function manifestProblems(
  file: string,
  meta: { id: string } & AppMeta,
  seen: readonly string[]
): string[] {
  const out: string[] = []
  if (!APP_ID_PATTERN.test(meta.id)) out.push(`${file}: ${badAppId(meta.id)}`)
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
 * 图标是文件约定：源图就那一张 `icon.png`，也不能没有。
 *
 * 组件入口那一条判据原来也在这里（"缺 index.tsx"），随着构建期 glob 一起退场了：
 * 现在入口文档是包的一部分，缺不缺由产包器与运行期注册各自喊一次
 * （`code/pack-app.mjs` 的 `layoutProblems`、`services/packageRegistry.ts`）。
 * "有多张"那一条随格式收窄（2026-11-26 起只认 png）一起退场：名字钉死就不存在第二张。
 */
export function iconProblems(id: string, iconKeys: readonly string[]): string[] {
  if (iconKeys.length === 0) {
    return [`${id}: 缺图标 apps/${id}/${ICON_NAME}（源图只认 png，svg / jpg / jpeg / webp 已退场）`]
  }
  const stale = iconKeys.filter((k) => RETIRED_ICON_PATTERN.test(k.split('/').pop()!))
  if (stale.length > 0) {
    return [`${id}: 源图格式 runtime 不认：${stale.join(', ')}——只留一张 apps/${id}/${ICON_NAME}`]
  }
  return []
}
