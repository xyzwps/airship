import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestProblems } from '@airship/contract'
import { ICON_PATTERN, entryOf, packageManifestProblems, DEFAULT_ENTRY } from '@airship/contract'
import type { AppMeta } from '@airship/contract'

/**
 * 用例侧的"源码那批应用"——与运行期扫包**分开的两条腿**。
 *
 * 产品代码里已经没有应用名单了（壳运行期扫包，见 `services/packageRegistry.ts`）。
 * 但用例还得拿着仓库里的真清单做三件事，这些是"扫磁盘上的包"给不了的：
 *
 *   1. 核对产包结果与源码清单是同一批（AP-008：包与 `app.ts` 不许分叉）；
 *   2. 扫每个应用的源码，验它用到的契约域都在清单里声明（AP-011）、没引壳的实现（AP-013）；
 *   3. 拿真 id 与真尺寸喂给运行期扫描，构造出"这台机器上装了哪些包"。
 *
 * 这份 glob 只许住在这里：**产品代码里再出现 glob 应用目录就是走回头路**。
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const APPS_DIR = join(SRC, 'apps')
const manifests = import.meta.glob<{ app: AppMeta }>('../../../apps/*/app.ts', { eager: true })

/** 仓库里的应用清单，按 id 序 */
export const REAL_APPS: AppMeta[] = Object.values(manifests)
  .map((m) => m.app)
  .sort((a, b) => a.id.localeCompare(b.id))

export const REAL_APP_IDS: string[] = REAL_APPS.map((m) => m.id).sort()

/** 应用目录：源码里的那个 src/apps/<id> */
export function appSourceDir(id: string): string {
  return join(APPS_DIR, id)
}

/** 这个应用目录下所有 .ts/.tsx 源码（用例扫引用方向用） */
export function appSources(id: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(appSourceDir(id))) {
    const p = join(appSourceDir(id), name)
    if (statSync(p).isDirectory()) continue
    if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

export function readSource(file: string): string {
  return readFileSync(file, 'utf8')
}

/**
 * 一个应用该有哪几份源文件。
 *
 * 与包格式同一套约定：清单 `app.ts` + 入口文档 `index.html` + 入口脚本 `main.tsx` + 一张图标。
 * 缺一件就是产包期报错（`code/pack-app.mjs`），这里给用例同一份判据。
 */
export function appSourceProblems(id: string): string[] {
  const dir = appSourceDir(id)
  const out: string[] = []
  const names = readdirSync(dir)
  for (const need of ['app.ts', 'index.html', 'main.tsx']) {
    if (!names.includes(need)) out.push(`src/apps/${id} 缺 ${need}`)
  }
  const icons = names.filter((n) => ICON_PATTERN.test(n))
  if (icons.length !== 1) out.push(`src/apps/${id} 的图标该有且只有一张，实际 ${icons.length} 张：${icons.join(', ')}`)
  return out
}

/** 把源码清单投影成一份包清单（补上包格式那三个字段） */
export function manifestOf(meta: AppMeta, sdkVersion = '0.0.0-test'): Record<string, unknown> {
  return { ...meta, schemaVersion: 1, sdkVersion, entry: DEFAULT_ENTRY }
}

/** 清单投影过的是产包器与壳侧同一份判据；这里给用例一个"应该零问题"的断言入口 */
export function manifestProblemsOf(meta: AppMeta): string[] {
  const projected = manifestOf(meta)
  return [
    ...packageManifestProblems(projected, `src/apps/${meta.id}/app.ts`),
    ...manifestProblems(`src/apps/${meta.id}/app.ts`, meta.id, meta, [])
  ]
}

export { entryOf }
