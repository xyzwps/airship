import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { airshipCspPlugin } from '@airship/sdk/vite'

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

const SRC = join(__dirname, '..', '..')
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
      // 册子与用例跟着代码放在区域里，但它们不是被扫描的产品源码
      if (name === 'node_modules' || name === 'out' || name === 'tests' || name === 'specs' || name === '__tests__') continue
      out.push(...sources(p, exts))
    } else if (exts.some((e) => name.endsWith(e))) {
      // 测试文件允许为了断言而提到应用名
      if (!name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) out.push(p)
    }
  }
  return out
}

// 仓库根（src 的上一层）：包声明与构建工装都在这一层看
const REPO = join(__dirname, '..', '..', '..')
const ROOT = REPO

/** 一棵目录下的全部源码文件（含测试工装自己） */
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'out' || name === '.tmp') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/.(ts|tsx|mjs|mts)$/.test(name)) out.push(p)
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
const SHELL_P = srcPosix(SHELL_DIR)

/**
 * 包名 → 目录。npm workspaces 之后，边界不再只写在注释里：
 * 引 `@airship/<包>` 就是引那个包，摸它的内部文件要么被 exports 挡掉，要么被这里挡掉。
 */
const APP_NAMES = new Set(discoveredAppIds().map((id) => `@airship/${id}`))
/** 允许被外部摸到内部路径的导出（SDK 的两个子入口） */
// SDK 的三个公开子入口：测试替身、基线样式、给构建配置用的 CSP 注入插件
const ALLOWED_SUBPATHS = ['@airship/sdk/testing', '@airship/sdk/styles.css', '@airship/sdk/vite']

/** 说明符指向哪个应用包（npm 名或相对路径都算） */
function appTarget(file: string, spec: string): string | null {
  if (spec.startsWith('@airship/')) {
    const name = spec.slice('@airship/'.length).split('/')[0]!
    return APP_NAMES.has(`@airship/${name}`) ? name : null
  }
  const resolved = resolveSpec(file, spec)
  if (!resolved || !resolved.startsWith(APPS_P + '/')) return null
  return resolved.slice(APPS_P.length + 1).split('/')[0] ?? null
}

/** 说明符指向哪个区（shell / sdk / shared / apps / 其他） */
function areaTarget(file: string, spec: string): string | null {
  if (spec.startsWith('@airship/shell')) return 'shell'
  if (spec.startsWith('@airship/sdk')) return 'sdk'
  if (spec.startsWith('@airship/contract') || spec.startsWith('@airship/library') || spec.startsWith('@airship/textdecode'))
    return 'shared'
  const resolved = resolveSpec(file, spec)
  if (!resolved) return null
  if (resolved.startsWith(SHELL_P + '/')) return 'shell'
  if (resolved.startsWith(srcPosix(join(SRC, 'sdk')) + '/')) return 'sdk'
  if (resolved.startsWith(SHARED_P + '/')) return 'shared'
  return null
}

describe('应用注册', () => {
  it('每个应用目录都有 app.ts、index.html、main.tsx 与一张图标，且 id 与目录名一致', () => {
    const dirs = readdirSync(APPS_DIR).filter(
      (n) => statSync(join(APPS_DIR, n)).isDirectory() && n !== 'specs' && n !== 'tests'
    )
    for (const dir of dirs) {
      expect(existsSync(join(APPS_DIR, dir, 'app.ts')), `${dir}/app.ts 必须存在`).toBe(true)
      // 包自持：入口文档与装组件的那份脚本各一份，缺一样这个包就开不出窗口
      expect(existsSync(join(APPS_DIR, dir, 'index.html')), `${dir}/index.html 必须存在`).toBe(true)
      expect(existsSync(join(APPS_DIR, dir, 'main.tsx')), `${dir}/main.tsx 必须存在`).toBe(true)
      // CSP 由 src/sdk/csp.ts 在构建时注入，应用不许自己抄一条
      const html = readFileSync(join(APPS_DIR, dir, 'index.html'), 'utf8')
      expect(html, `${dir}/index.html 里不许自己写 CSP`).not.toMatch(/Content-Security-Policy/)
      expect(html, `${dir}/index.html 的入口脚本必须是相对路径（dev 与包里指的不是同一层）`).toContain(
        'src="./main.tsx"'
      )
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

describe('应用只引 SDK 与契约层（§4 / I-6）', () => {
  /**
   * AP-013：包要能被装进另一份壳里跑，所以应用与 SDK 都不许直连壳的实现。
   *
   * SDK 与 `@shared` 是应用能看到的全部：SDK 给宿主与观感，`@shared` 给契约与共享包。
   * 一旦应用直连 `src/shell/**`，"包自持"就是假的——那份包再也离不开这个仓库。
   */
  it('AP-013 应用不 import 壳的实现，SDK 也不 import 壳或应用', () => {
    const violations: string[] = []
    const scanned = [
      ...sources(APPS_DIR),
      ...sources(join(SRC, 'sdk')),
      ...topLevelSources(SHELL_DIR).filter((f) => !/\.html$/.test(f))
    ]
    for (const file of scanned) {
      const ownArea = srcPosix(file).slice(SRC.length + 1).split('/')[0]
      for (const spec of importSpecifiers(file)) {
        // 壳的渲染侧顶层文件（Launcher 等）引 SDK 是允许的；SDK 与 apps 反过来引壳不行
        const hitsShell = areaTarget(file, spec) === 'shell'
        const sdkIntoApps = ownArea === 'sdk' && appTarget(file, spec) !== null
        const fromAppOrSdk = ownArea === 'apps' || ownArea === 'sdk'
        if ((fromAppOrSdk && hitsShell) || sdkIntoApps) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `应用与 SDK 不许直连壳：\n${violations.join('\n')}`).toEqual([])
  })

  /**
   * AP-016：每个包都用自己的 package.json 说话。
   *
   * 外部作者复制一个应用目录出去，靠的就是这几份文件——它们不在，"范本"就只是这个仓库里的一个目录。
   */
  it('AP-016 每个区都是真包：package.json 在，名字带 @airship 前缀', () => {
    const expected = [
      join(SRC, 'shell', 'package.json'),
      join(SRC, 'sdk', 'package.json'),
      join(SRC, 'shared', 'contract', 'package.json'),
      join(SRC, 'shared', 'library', 'package.json'),
      join(SRC, 'shared', 'textdecode', 'package.json'),
      ...discoveredAppIds().map((id) => join(APPS_DIR, id, 'package.json'))
    ]
    for (const file of expected) {
      expect(existsSync(file), `${file.replace(ROOT + '\\', '')} 必须存在`).toBe(true)
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; private?: boolean }
      expect(pkg.name, `${file} 的 name 要带作用域前缀`).toMatch(/^@airship\//)
      // 这个仓库还没往任何 registry 发东西：每一个包都得是 private，写错就会误发
      expect(pkg.private, `${file} 得是 private`).toBe(true)
    }
    // 根只声明 workspaces，不带 scripts（命令的唯一真源是 justfile）
    const root = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
      workspaces?: string[]
      dependencies?: Record<string, string>
    }
    expect(root.scripts, '根 package.json 不许有 scripts').toBeUndefined()
    expect(root.workspaces, '根要声明 workspaces').toContain('src/apps/*')
  })

  /**
   * AP-014：CSP 只有一份，写在 `src/sdk/csp.ts`，构建时注入每个包的入口文档。
   *
   * 六个应用各抄一条权限字符串，就会有第六个版本悄悄少一个 `worker-src`；
   * 注入器还顺手把"应用自己写了 CSP"当成错误抛出来，所以这条路不会被动破。
   * 选哪一条的逻辑也归 csp.ts（`pickCsp`，判据见 AP-017）：注入器只递交"产包还是开发"
   * 与"清单有没有 net"这两个依据，自己手里不留任何一条字符串。
   */
  it('AP-014 CSP 的唯一真源在 SDK，应用入口 html 里没有那一条', () => {
    const cspSource = readFileSync(join(SRC, 'sdk', 'csp.ts'), 'utf8')
    expect(cspSource, '产线那条 CSP 必须存在').toMatch(/export const AIRSHIP_CSP/)
    expect(cspSource, 'dev 那条要单独一份：react-refresh 的内联前言过不了 script-src 自检').toMatch(
      /export const AIRSHIP_CSP_DEV/
    )
    expect(cspSource, '选哪一条 CSP 的逻辑住在 csp.ts 里，产包与开发、带不带 net 都在这一处判').toMatch(
      /export function pickCsp\(input: \{ bundle: boolean; net: boolean \}\)/
    )

    const injector = readFileSync(join(SRC, 'sdk', 'cspPlugin.ts'), 'utf8')
    expect(injector, '注入器要从 csp.ts 引选择逻辑，不许自己另选一条').toMatch(
      /import\s*\{\s*pickCsp\s*\}\s*from\s*'\.\/csp\.ts'/
    )
    expect(injector, '注入器只递交两个依据：构建还是开发、清单声明了没有 net').toMatch(
      /pickCsp\(\{[^}]*bundle:[^}]*net:[^}]*\}\)/
    )
    expect(injector, 'CSP 字符串一处都不许出现在注入器里——唯一真源在 csp.ts').not.toMatch(/AIRSHIP_CSP/)

    for (const dir of discoveredAppIds()) {
      const html = readFileSync(join(APPS_DIR, dir, 'index.html'), 'utf8')
      expect(html, `src/apps/${dir}/index.html 里不许自己写 CSP`).not.toMatch(/Content-Security-Policy/)
    }
  })

  /**
   * AP-017：注入哪一条 CSP 按清单选档——真调注入器，不读它的源码。
   *
   * 判据的原文是"两档只差 connect-src 的外连，脚本与 frame 一概不放宽"，
   * 最容易坏的地方恰恰是有人改字符串时顺手把 script-src 也松了，所以这里对结果说话。
   * filename 指到 src/apps/<id>/index.html 的真路径：注入器从它旁边的 app.ts 读能力位。
   */
  it('AP-017 注入的 CSP 按清单选档：只有声明了 net 的应用放宽 connect-src', () => {
    const doc =
      '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>工装</title></head><body><div id="root"></div></body></html>'

    const cspOf = (id: string): string => {
      // bundle 传非空对象：产包那一份是对外发布的形状，dev 档归截图与实测管
      const injected = airshipCspPlugin().transformIndexHtml(doc, {
        filename: join(APPS_DIR, id, 'index.html'),
        bundle: {}
      })
      const hit = /<meta http-equiv="Content-Security-Policy" content="([^"]+)" \/>/.exec(injected)
      expect(hit, `${id} 的入口文档没被注入 CSP`).not.toBeNull()
      return hit[1]!
    }

    const directive = (csp: string, name: string): string[] => {
      const line = csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name} `))
      expect(line, `CSP 里没有 ${name} 这一项`).not.toBeUndefined()
      return line!.split(/\s+/).slice(1)
    }

    const withNet = cspOf('s3')
    const withoutNet = cspOf('life')

    // 声明了 net 的：外连放到 http 与 https 两个协议；没声明的还是收紧那条
    expect(directive(withNet, 'connect-src')).toEqual(expect.arrayContaining(['http:', 'https:']))
    expect(directive(withoutNet, 'connect-src')).not.toContain('http:')
    expect(directive(withoutNet, 'connect-src')).not.toContain('https:')

    // 两档都没放宽的：脚本只认包里的那一份，frame 也不引外站
    for (const [id, csp] of [
      ['s3', withNet],
      ['life', withoutNet]
    ] as const) {
      expect(directive(csp, 'script-src'), `${id} 的 script-src 被放宽了`).toEqual(["'self'"])
      expect(directive(csp, 'frame-src'), `${id} 的 frame-src 被放宽了`).toEqual(["'self'", 'blob:'])
    }
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
      const ownPkg = srcPosix(file).slice(SHARED_P.length + 1).split('/')[0]
      for (const spec of importSpecifiers(file)) {
        const intoApp = appTarget(file, spec) !== null
        const intoShell = areaTarget(file, spec) === 'shell'
        // 相对路径跨出自己的包目录就算绕过（'../contract' 也不行——那是另一个包，要用包名引）
        const resolved = resolveSpec(file, spec)
        const ownPkgDir = `${SHARED_P}/${ownPkg}`
        const relativeEscape = resolved !== null && !resolved.startsWith(ownPkgDir + '/') && !resolved.startsWith(SHARED_P + '/contract')
        const namedIntoSharedDeep = /^@airship\/(contract|library|textdecode)\//.test(spec)
        if (intoApp || intoShell || relativeEscape || namedIntoSharedDeep) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `共享包只能依赖契约层，且要用包名引：\n${violations.join('\n')}`).toEqual([])
  })

  it('壳不 import 任何应用——它只在运行期扫包', () => {
    const violations: string[] = []
    const scanned = [
      ...topLevelSources(SHELL_DIR),
      ...sources(join(SHELL_DIR, 'main')),
      ...sources(join(SHELL_DIR, 'preload'))
    ]
    for (const file of scanned) {
      for (const spec of importSpecifiers(file)) {
        // 拆包前壳还要 import 应用清单（纯数据那一份）；现在连这条都没了：清单从磁盘读
        if (appTarget(file, spec) !== null) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `壳不该 import 任何应用（名单来自运行期扫包）：\n${violations.join('\n')}`).toEqual([])
  })
})

describe('包入口（§8.1 规则 1）', () => {
  it('外部只 import 包的入口，不摸包内文件', () => {
    const violations: string[] = []
    const scanned = [...sources(APPS_DIR), ...topLevelSources(SHELL_DIR), ...sources(join(SRC, 'sdk')), ...sources(SHARED_DIR)]
    for (const file of scanned) {
      for (const spec of importSpecifiers(file)) {
        if (ALLOWED_SUBPATHS.includes(spec)) continue
        // '@airship/library/x' 这种更深一层就是绕过入口
        if (/^@airship\/[a-z-]+\//.test(spec)) violations.push(`${srcPosix(file)} → ${spec}`)
      }
    }
    expect(violations, `绕过包入口就是破坏契约可见性：\n${violations.join('\n')}`).toEqual([])
  })
})

describe('旧别名不该回来', () => {
  it('仓库里不再有 @shared / @sdk / @apps / @shell / @tests 说明符', () => {
    const stale = /['"]@(shared|sdk|apps|shell|tests)[\\/]/
    const hits: string[] = []
    for (const file of [...sources(APPS_DIR), ...sources(SHELL_DIR), ...sources(SHARED_DIR), ...sources(join(SRC, 'sdk')), ...files(join(REPO, 'code'))]) {
      if (stale.test(readFileSync(file, 'utf8'))) hits.push(srcPosix(file))
    }
    expect(hits, `这些文件还在用别名，说明符该换成 @airship/*：\n${hits.join('\n')}`).toEqual([])
  })
})

describe('壳侧零应用字面量（I-5 的直接证明）', () => {
  const appIds = discoveredAppIds()

  // 只扫 src/shell：壳不该知道任何具体应用。
  // 不扫 src/shared——那里出现的 'pdf' 是书的格式名，不是应用名，扫它会误报。
  it('AP-010 加一个应用不改动壳的任何文件：壳侧不出现任何具体应用 id', () => {
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
