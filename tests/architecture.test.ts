import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 架构不变量的可执行版本（docs/architecture.md §2、§4、§8）。
 *
 * 这些规则平时靠自觉，自觉会退化，所以做成测试：谁破坏了"改一个应用不用管其他应用"，
 * 测试直接红，而不是等下次重构才发现到处都在互相摸。
 *
 * 目录按角色分：src/shell（外壳）/ src/apps（应用）/ src/shared（契约与共享包）。
 * 应用 id 一律从目录扫出来，测试本身不写死任何应用——
 * 否则这个测试就成了又一处"加应用要改壳侧文件"。
 */

const SRC = join(__dirname, '..', 'src')
const APPS_DIR = join(SRC, 'apps')
const SHELL_DIR = join(SRC, 'shell')
const SHARED_DIR = join(SRC, 'shared')

/** 扫出当前所有应用 id（有 app.ts 清单的目录才算注册了） */
function discoveredAppIds(): string[] {
  return readdirSync(APPS_DIR)
    .filter((name) => {
      const p = join(APPS_DIR, name)
      return statSync(p).isDirectory() && existsSync(join(p, 'app.ts'))
    })
    .sort()
}

/** 收集某棵目录下的源码文件 */
function sources(dir: string, exts = ['.ts', '.tsx']): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'out' || name === '__tests__') continue
      out.push(...sources(p, exts))
    } else if (exts.some((e) => name.endsWith(e))) {
      // 测试文件允许为了断言而提到应用名
      if (!name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) out.push(p)
    }
  }
  return out
}

/** 只取某目录顶层的文件（壳的渲染侧代码就在 src/shell 顶层） */
function topLevelSources(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n))
    .map((n) => join(dir, n))
}

/**
 * 粗剥注释：够挡住"文档里提到某个应用"造成的误报。
 * 保护 `file://` 和 `https://`——冒号后的 // 不是注释起点。
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** 取出一个文件里所有 import 说明符 */
function importSpecifiers(file: string): string[] {
  const code = stripComments(readFileSync(file, 'utf8'))
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g
  const out: string[] = []
  for (let m = re.exec(code); m !== null; m = re.exec(code)) out.push(m[1]!)
  return out
}

/** 把相对说明符归一成绝对 posix 路径；别名说明符返回 null（另行判定） */
function resolveSpec(file: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = posix.dirname(file.replace(/\\/g, '/'))
  return posix.normalize(posix.join(base, spec))
}

const srcPosix = (p: string): string => p.replace(/\\/g, '/')
const APPS_P = srcPosix(APPS_DIR)
const SHARED_P = srcPosix(SHARED_DIR)

/** 说明符指向哪个应用目录（相对或 @apps 别名都算） */
function appTarget(file: string, spec: string): string | null {
  if (spec.startsWith('@apps/')) return spec.slice('@apps/'.length).split('/')[0] ?? null
  const resolved = resolveSpec(file, spec)
  if (!resolved || !resolved.startsWith(APPS_P + '/')) return null
  return resolved.slice(APPS_P.length + 1).split('/')[0] ?? null
}

describe('应用注册', () => {
  it('每个应用目录都有 app.ts 与 index.tsx，且 id 与目录名一致', () => {
    const dirs = readdirSync(APPS_DIR).filter((n) => statSync(join(APPS_DIR, n)).isDirectory())
    for (const dir of dirs) {
      expect(existsSync(join(APPS_DIR, dir, 'app.ts')), `${dir}/app.ts 必须存在`).toBe(true)
      expect(existsSync(join(APPS_DIR, dir, 'index.tsx')), `${dir}/index.tsx 必须存在`).toBe(true)
      // 图标是文件约定：apps/<id>/icon.svg|png|jpg|jpeg|webp，而且只能有一张
      const icons = readdirSync(join(APPS_DIR, dir)).filter((n) => /^icon\.(svg|png|jpe?g|webp)$/.test(n))
      expect(icons.length, `${dir}/ 必须有且只有一张 icon.* 文件`).toBe(1)
      const meta = readFileSync(join(APPS_DIR, dir, 'app.ts'), 'utf8')
      expect(meta, `${dir}/app.ts 的 id 必须等于目录名`).toContain(`id: '${dir}'`)
    }
  })

  it('至少发现到一个应用（glob 路径写错时不至于静默发现零个）', () => {
    expect(discoveredAppIds().length).toBeGreaterThan(0)
  })
})

describe('依赖方向（§4 / I-1）', () => {
  it('应用不 import 另一个应用', () => {
    const violations: string[] = []
    for (const file of sources(APPS_DIR)) {
      // 自己所在的目录名，指向自己不算跨应用
      const own = srcPosix(file).slice(APPS_P.length + 1).split('/')[0]
      for (const spec of importSpecifiers(file)) {
        const target = appTarget(file, spec)
        if (target && target !== own) violations.push(`${file} → ${spec}`)
      }
    }
    expect(violations, `应用之间不得互相 import：\n${violations.join('\n')}`).toEqual([])
  })

  it('共享包不 import 应用，也不 import 壳（共享在依赖图最下层）', () => {
    const violations: string[] = []
    for (const file of sources(SHARED_DIR)) {
      for (const spec of importSpecifiers(file)) {
        const resolved = resolveSpec(file, spec)
        const escapes =
          (resolved && !resolved.startsWith(SHARED_P + '/')) ||
          spec.startsWith('@apps') ||
          spec.startsWith('@shell')
        if (escapes) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `共享包只能依赖契约层，不许反向依赖应用或壳：\n${violations.join('\n')}`).toEqual([])
  })

  it('壳不摸应用内部模块，只走 apps 的注册表', () => {
    const violations: string[] = []
    for (const file of [...topLevelSources(SHELL_DIR), ...sources(join(SHELL_DIR, 'main')), ...sources(join(SHELL_DIR, 'preload'))]) {
      for (const spec of importSpecifiers(file)) {
        // 允许 '@apps' / '../apps'（注册表本身），禁止指向某个应用目录内部
        const target = appTarget(file, spec)
        const deeper =
          target !== null &&
          (spec.startsWith('@apps/') ? spec.split('/').length > 2 : !/\/apps\/?$/.test(resolveSpec(file, spec) ?? ''))
        if (deeper) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `壳只能 import 应用注册表：\n${violations.join('\n')}`).toEqual([])
  })
})

describe('共享包入口（§8.1 规则 1）', () => {
  it('外部只 import 包目录，不摸包内文件', () => {
    const violations: string[] = []
    const scanned = [...sources(APPS_DIR), ...topLevelSources(SHELL_DIR)]
    for (const file of scanned) {
      for (const spec of importSpecifiers(file)) {
        // '@shared/library/x' 或 '../../shared/library/x' 这种更深一层就算绕过
        const tail = spec.startsWith('@shared/')
          ? spec.slice('@shared/'.length)
          : (() => {
              const resolved = resolveSpec(file, spec)
              return resolved && resolved.startsWith(SHARED_P + '/') ? resolved.slice(SHARED_P.length + 1) : null
            })()
        if (tail && tail.split('/').length > 1) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `绕过共享包入口就是破坏契约可见性：\n${violations.join('\n')}`).toEqual([])
  })
})

describe('壳侧零应用字面量（I-5 的直接证明）', () => {
  const appIds = discoveredAppIds()

  // 只扫 src/shell：壳不该知道任何具体应用。
  // 不扫 src/shared——那里出现的 'pdf' 是书的格式名，不是应用名，扫它会误报。
  it('main / preload / 壳界面里不出现任何具体应用 id', () => {
    const violations: string[] = []
    const scanned = [
      ...topLevelSources(SHELL_DIR),
      ...sources(join(SHELL_DIR, 'main')),
      ...sources(join(SHELL_DIR, 'preload'))
    ]
    for (const file of scanned) {
      const code = stripComments(readFileSync(file, 'utf8'))
      for (const id of appIds) {
        const quoted = new RegExp(`['"\`]${id}['"\`]`)
        const asPath = new RegExp(`apps/${id}/`)
        if (quoted.test(code) || asPath.test(code)) violations.push(`${srcPosix(file)} 提到 "${id}"`)
      }
    }
    expect(
      violations,
      `加一个应用不该回来改壳侧文件；壳侧却写死了应用名：\n${violations.join('\n')}`
    ).toEqual([])
  })
})
