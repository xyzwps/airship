import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_ID_PATTERN,
  MANIFEST_NAME,
  SCHEMA_VERSION,
  WINDOWS_ICON_NAME,
  idShapeProblem,
  layoutProblems,
  manifestProblems,
  pack,
  referenceProblems
} from '../../../code/pack-app.mjs'
import { packPackage } from '@airship/cli/pack'
import { compileBackend } from '@airship/cli'
import { WINDOWS_ICON_NAME as CONTRACT_WINDOWS_ICON_NAME, PACKAGE_BACKEND_ENTRY } from '@airship/contract'
import { badAppId } from '@airship/contract'
import { APP_ID_PATTERN as CONTRACT_APP_ID_PATTERN } from '@airship/contract'
import { manifestProblems as registryManifestProblems } from '@airship/contract'
import { packageManifestProblems } from '@airship/contract'
import { REAL_APP_IDS, REAL_APPS, appSourceDir } from '../../runtime/tests/helpers/realApps'
import { DEFAULT_ENTRY } from '@airship/contract'
import { archiveEntryNames, readArchiveEntry, readArchiveText } from '../../runtime/main/services/packageArchive'
import { registerPackageAt } from '../../runtime/main/services/packageRegistry'
import { writeArchive } from '../../runtime/tests/helpers/packages'

/**
 * PK-001 ~ PK-007：一个 airship 包在磁盘上的形状。
 *
 * 契约在 src/apps/specs/package.md，影子在这里。
 * 产包器 code/pack-app.mjs 现在只是 @airship/cli 的薄适配，判据只有 @airship/contract 那一份——
 * 从前"Node 跑不了本仓 TS、两侧各写一份、用例钉相等"的局面随 contract 的 dist 一起退场了。
 * 下面对旧导出名的相等断言留着，防的是适配层哪天又抄出一份来。
 *
 * 产物一律落在系统临时目录，不留进仓库（AGENTS.md 的本机事实）。
 */

let work = ''

/** 包根那张源图在用例里的样子（产包期不转格式，它只是随包带着的一张图） */
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>'
/** 应用作者自备的那份外壳图标：ICO 头是保留字节 0、类型 1（单图图标），用例只需要形状合格 */
const WINDOWS_ICON = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0])

/** 一个够格的产物目录：入口 + 图标 + 外壳图标 + 一份相对引用的资产 */
function fixture(
  options?: { html?: string; icons?: string[]; extraFiles?: Record<string, string>; windowsIcon?: boolean }
): string {
  const dir = mkdtempSync(join(work, 'src-'))
  const html =
    options?.html ??
    [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '  <head><link rel="stylesheet" href="assets/styles.css"></head>',
      '  <body><div id="root"></div><script type="module" src="assets/main.js"></script></body>',
      '</html>'
    ].join('\n')
  writeFileSync(join(dir, 'index.html'), html, 'utf8')
  for (const icon of options?.icons ?? ['icon.svg']) writeFileSync(join(dir, icon), ICON_SVG, 'utf8')
  if (options?.windowsIcon !== false) writeFileSync(join(dir, WINDOWS_ICON_NAME), WINDOWS_ICON)
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'main.js'), 'console.log(1)', 'utf8')
  writeFileSync(join(dir, 'assets', 'styles.css'), 'body{margin:0}', 'utf8')
  for (const [name, text] of Object.entries(options?.extraFiles ?? {})) {
    const target = join(dir, name)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, text, 'utf8')
  }
  return dir
}

const goodManifest = {
  id: 'demo',
  name: '示范',
  description: '一个用来验形状的最小包',
  capabilities: [],
  schemaVersion: SCHEMA_VERSION,
  sdkVersion: '1.0.0'
}

function json(over?: Record<string, unknown>, drop?: readonly string[]): string {
  const m: Record<string, unknown> = { ...goodManifest, ...over }
  for (const key of drop ?? []) delete m[key]
  return JSON.stringify(m)
}

function outRoot(): string {
  const dir = mkdtempSync(join(work, 'out-'))
  return dir
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'airship-pack-'))
})

describe('包是一个自带清单的归档，名字由 id 定', () => {
  it('PK-001 id 不合形状时把规则念出来，且产包器与 runtime 侧判的是同一条', () => {
    for (const bad of ['墨读', 'Life', 'a b', 'a%20b', 'a#b', '-demo', 'demo.v2', 'x'.repeat(33)]) {
      expect(manifestProblems({ ...goodManifest, id: bad }), `id ${JSON.stringify(bad)} 该被拒`).not.toEqual([])
    }
    for (const ok of ['a', 'life', 'gosper-gun', 'x'.repeat(32)]) {
      expect(manifestProblems({ ...goodManifest, id: ok }), `id ${ok} 该收下`).toEqual([])
    }

    // 适配层露出的名字就是契约那一份（同源才谈得上"逐字相同"）
    expect(idShapeProblem('墨读')).toBe(badAppId('墨读'))
    expect(APP_ID_PATTERN.source).toBe(CONTRACT_APP_ID_PATTERN.source)
    const fromContract = registryManifestProblems(
      'apps/墨读/app.ts',
      '墨读',
      { id: '墨读', name: '墨读', description: '', capabilities: [] },
      []
    )
    expect(fromContract).toEqual([`apps/墨读/app.ts: ${badAppId('墨读')}`])

    // 现有八个应用的 id 全部通过这一条
    for (const meta of REAL_APPS) expect(APP_ID_PATTERN.test(meta.id), `${meta.id} 该合形状`).toBe(true)
  })

  it('PK-002 缺清单或清单不是合法 JSON，失败并点名，不写半成品目录', () => {
    const src = fixture()
    const out = outRoot()

    expect(() => pack({ srcDir: src, outRoot: out })).toThrow(/manifest\.json 不存在/)
    expect(() => pack({ srcDir: src, outRoot: out, manifestText: '{ id:' })).toThrow(/manifest\.json 解析失败/)
    expect(readdirSync(out), '包根里不该出现半成品').toEqual([])

    // 失败不留痕，也不碰已经产好的旧包：入口指到包里没有的名字同样是响亮失败
    const first = pack({ srcDir: fixture(), outRoot: out, manifestText: json() })
    const before = readdirSync(out)
    const beforeHtml = readArchiveText(first.file, DEFAULT_ENTRY)
    expect(() => pack({ srcDir: fixture(), outRoot: out, manifestText: json({ entry: 'page.html' }) })).toThrow(
      /包里没有入口文件 page\.html/
    )
    const bad = fixture({ html: '<script src="https://cdn.example/app.js"></script>' })
    expect(() => pack({ srcDir: bad, outRoot: out, manifestText: json() })).toThrow(/包不合格/)
    expect(readdirSync(out), '包根只剩那个旧包').toEqual(before)
    expect(readArchiveText(first.file, DEFAULT_ENTRY), '旧包的入口文档一个字节都没变').toBe(beforeHtml)
    expect(readdirSync(out).some((n) => /\.airship\.(tmp|prev)-/.test(n)), '不许留半成品').toBe(false)
  })

  it('PK-003 包格式对不上 runtime 认的那一档就拒，sdkVersion 缺了也拒', () => {
    expect(manifestProblems({ ...goodManifest, schemaVersion: 2 })).toContain(
      `包清单 schemaVersion 只认 ${SCHEMA_VERSION}，收到 2（包格式与 runtime 不同档时别硬装，先对齐 runtime 的版本）`
    )

    const noSdk = manifestProblems(JSON.parse(json(undefined, ['sdkVersion'])))
    expect(noSdk.some((p: string) => p.includes('sdkVersion')), noSdk.join('\n')).toBe(true)
  })
})

describe('包清单只写应用自己的事实', () => {
  it('PK-004 图标是文件不是字段：字段被拒，缺一张或多一张也被拒', () => {
    expect(manifestProblems({ ...goodManifest, iconPath: 'icon.svg' })[0]).toContain('图标是包根那一张文件')
    expect(manifestProblems({ ...goodManifest, order: 3 })[0]).toContain('顺序由 runtime 按名字典序定')

    const none = layoutProblems({ fileNames: ['index.html'], manifest: goodManifest })
    expect(none[0]).toContain('缺图标 icon.svg')

    const two = layoutProblems({ fileNames: ['index.html', 'icon.svg', 'icon.png'], manifest: goodManifest })
    expect(two[0]).toBe('包里的图标有多张，只留一张：icon.svg, icon.png')

    // 随包备好的 icon.ico（PK-036）不算第二张图标：外壳只认磁盘上的 .ico
    expect(layoutProblems({ fileNames: ['index.html', 'icon.svg', 'icon.ico'], manifest: goodManifest })).toEqual([])
  })

  it('PK-005 runtime 不认的键、不像话的值，都点名到字段与收到的东西', () => {
    expect(manifestProblems({ ...goodManifest, capabilitis: [] })).toContain(
      '包清单有 runtime 不认的键 "capabilitis"（要么拼错，要么包格式与 runtime 不同档）'
    )
    expect(manifestProblems({ ...goodManifest, name: '  ' })).toContain('包清单 name 必须是非空字符串，收到 "  "')
    expect(manifestProblems({ ...goodManifest, capabilities: 'fs.read' })).toContain(
      '包清单 capabilities 必须是字符串数组，用不到就写空数组'
    )
    expect(manifestProblems({ ...goodManifest, defaultWidth: 'wide' })).toContain(
      '包清单 defaultWidth 必须是正整数像素值，收到 "wide"'
    )
  })
})

describe('随包自带的后台程序按约定进包', () => {
  it('PK-040 应用目录里有 backend.ts，包根就有编好的 backend.js；没有就安静不带', async () => {
    const appDir = mkdtempSync(join(work, 'app-'))
    writeFileSync(join(appDir, 'backend.ts'), "import { pong } from './ping'\nprocess.parentPort.postMessage({ ready: pong() })\n", 'utf8')
    writeFileSync(join(appDir, 'ping.ts'), "export const pong = () => 'pong'\n", 'utf8')
    const srcDir = fixture()
    await compileBackend(appDir, srcDir)
    const js = readFileSync(join(srcDir, PACKAGE_BACKEND_ENTRY), 'utf8')
    expect(js, '本地 import 被 bundle 进同一条文件').toContain('pong')
    expect(js, '包里的是编好的 JS：不剩相对 ESM 引用').not.toMatch(/from ['"]\.\//)

    const out = outRoot()
    const packed = pack({ srcDir, outRoot: out, manifestText: json() })
    expect(archiveEntryNames(packed.file), '包根有那个条目').toContain(PACKAGE_BACKEND_ENTRY)
    expect(JSON.parse(readArchiveText(packed.file, MANIFEST_NAME)), '清单里没有键表述它').not.toHaveProperty('backend')

    // 没有条目就没有后台：应用目录不放文件，包不带 backend.js
    const plain = fixture()
    await compileBackend(mkdtempSync(join(work, 'empty-')), plain)
    const out2 = outRoot()
    const plainPacked = pack({ srcDir: plain, outRoot: out2, manifestText: json() })
    expect(archiveEntryNames(plainPacked.file), '没有后端入口，包根不该多出条目').not.toContain(PACKAGE_BACKEND_ENTRY)

    // 清单再写 backend 键：它已不在允许字段里，按未知键拒
    expect(manifestProblems({ ...goodManifest, backend: 'backend.js' })[0]).toContain('不认的键')
  })

  it('PK-041 backend.ts 与 backend.js 都在，产期响亮失败', async () => {
    const appDir = mkdtempSync(join(work, 'app-'))
    writeFileSync(join(appDir, 'backend.ts'), 'x', 'utf8')
    writeFileSync(join(appDir, 'backend.js'), 'x', 'utf8')
    await expect(compileBackend(appDir, mkdtempSync(join(work, 'built-')))).rejects.toThrow(
      '后端入口只能有一份：backend.ts 与 backend.js 都在——留一个，复杂应用的目录归这个文件自己组织'
    )
  })
})

describe('包里的东西只能在包内互相引用', () => {
  it('PK-006 外部与越界的引用一条条念出来，内联的放行', () => {
    const blocked = [
      '<script src="http://cdn.example/app.js"></script>',
      '<script src="https://cdn.example/app.js"></script>',
      '<link href="//cdn.example/app.css">',
      '<script src="/assets/main.js"></script>',
      '<script src="../outside/main.js"></script>'
    ]
    for (const html of blocked) {
      const problems = referenceProblems(html)
      expect(problems.length, `该拦住：${html}`).toBe(1)
    }

    const allowed = referenceProblems('<script src="data:text/javascript,alert(1)"><a href="#top">x</a>')
    expect(allowed).toEqual([])

    // 拦得住也装得上：把外链换成内联，包就产出来
    const src = fixture({ html: '<script src="data:text/javascript,void 0"></script><link href="assets/styles.css">' })
    const out = outRoot()
    const { file } = pack({ srcDir: src, outRoot: out, manifestText: json() })
    // 产出来的是一个归档文件，不是目录：条目名才是包内的路径
    expect(statSync(file).isFile(), '包是 <id>.airship 一个文件').toBe(true)
    const entries = archiveEntryNames(file)
    expect(entries).toContain(MANIFEST_NAME)
    expect(entries, '产物与图标都要在归档里').toEqual(expect.arrayContaining(['index.html', 'icon.svg', 'assets/main.js']))
    expect(readArchiveText(file, 'assets/main.js')).toContain('console.log')
    expect(JSON.parse(readArchiveText(file, MANIFEST_NAME) ?? '{}').id).toBe('demo')
  })

  it('PK-007 注册失败不动磁盘一个字节', () => {
    // 注册是只读判定：不合格的归档拒下来，字节与目录原样，失败多少次都不写
    const dir = mkdtempSync(join(work, 'reg-'))
    const listing = readdirSync(dir)

    const broken = writeArchive(join(dir, 'demo.airship'), {
      [MANIFEST_NAME]: '{ 残缺',
      'icon.svg': '<svg/>'
    })
    const brokenBytes = readFileSync(broken)
    const missingEntry = writeArchive(join(dir, 'noentry.airship'), {
      [MANIFEST_NAME]: json({ id: 'noentry', entry: 'page.html' }),
      'icon.svg': '<svg/>'
    })
    const missingBytes = readFileSync(missingEntry)

    const first = registerPackageAt(broken)
    expect(first.pkg).toBeUndefined()
    expect(first.problems.join('\n')).toContain('解析失败')
    const second = registerPackageAt(missingEntry)
    expect(second.pkg).toBeUndefined()
    expect(second.problems.join('\n')).toContain('包里没有入口文件 page.html')

    // 再拒一次：还是什么都不写
    registerPackageAt(broken)
    registerPackageAt(missingEntry)
    expect(readFileSync(broken).equals(brokenBytes), '坏清单那份归档字节没变').toBe(true)
    expect(readFileSync(missingEntry).equals(missingBytes), '缺入口那份归档字节没变').toBe(true)
    expect(readdirSync(dir).sort()).toEqual([...listing, 'demo.airship', 'noentry.airship'].sort())
    expect(readdirSync(dir).some((n) => /\.airship\.(tmp|prev)-/.test(n)), '不许留残留').toBe(false)
  })
})

describe('包根那份随包备好的 Windows 外壳图标', () => {
  it('PK-036 应用目录里的 icon.ico 原样进包根；产包不转格式，安装器只取不转', () => {
    // 两处常量必须是同一个名字：产包侧搬它、runtime 与安装器读它
    expect(WINDOWS_ICON_NAME).toBe(CONTRACT_WINDOWS_ICON_NAME)

    const src = fixture()
    const out = outRoot()
    const { file } = pack({ srcDir: src, outRoot: out, manifestText: json() })
    expect(archiveEntryNames(file), '包根要有那份外壳图标').toContain(WINDOWS_ICON_NAME)
    // 原样搬：包里的字节与应用目录里那份一字不差——产包期不存在任何转换
    expect([...readArchiveEntry(file, WINDOWS_ICON_NAME)!]).toEqual([...readFileSync(join(src, WINDOWS_ICON_NAME))])

    // 八个应用目录都备着这张多尺寸 ico：缺一份产包期就报错，用例先在这里把它喊出来
    for (const id of REAL_APP_IDS) {
      const p = join(appSourceDir(id), WINDOWS_ICON_NAME)
      expect(existsSync(p), `src/apps/${id} 缺 ${WINDOWS_ICON_NAME}`).toBe(true)
      const bytes = readFileSync(p)
      // ICO 头部前两档是保留字节 0、类型 1（单图图标）
      expect([...bytes.subarray(0, 4)], `${id} 的 icon.ico 头部该是单图图标`).toEqual([0, 0, 1, 0])
      expect(bytes.length, `${id} 的多尺寸 ico 不该是个空壳`).toBeGreaterThan(1000)
    }

    // 全仓没有转图标这一步了：脚本、配方与依赖三样都随这条契约退场，安装器与仓库驱动只是取包内那一份
    const REPO = join(__dirname, '..', '..', '..')
    for (const gone of ['code/app-ico.py', 'code/make-ico.py', 'code/make-icons.py']) {
      expect(existsSync(join(REPO, gone)), `${gone} 该随这条契约一起退场`).toBe(false)
    }
    expect(readFileSync(join(REPO, 'justfile'), 'utf8'), 'just 里不再有重出图标的配方').not.toMatch(/^icon:$/m)
    expect(
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).devDependencies,
      '转 SVG 的那份依赖也不再要了'
    ).not.toHaveProperty('@resvg/resvg-js')
    const installer = readFileSync(join(REPO, 'src', 'cli', 'lib', 'installer.mjs'), 'utf8')
    expect(installer, '安装器要取包内那份 icon.ico').toContain(WINDOWS_ICON_NAME)
    expect(installer, '安装器不转图标').not.toContain('Resvg')
    expect(readFileSync(join(REPO, 'code', 'make-app-installer.mjs'), 'utf8'), '仓库驱动也只是取').not.toContain(
      'Resvg'
    )
  })

  it('PK-039 自备的 icon.ico 缺了响亮失败，补上就进包根且不算第二张图标', () => {
    const src = fixture({ windowsIcon: false })
    const out = outRoot()
    expect(() => packPackage({ srcDir: src, outRoot: out, manifestText: json() })).toThrow(
      '包根没有 icon.ico：任务栏与快捷方式那颗外壳图标只认磁盘上的 .ico'
    )
    expect(readdirSync(out), '缺图标产包不留任何归档').toEqual([])

    writeFileSync(join(src, WINDOWS_ICON_NAME), WINDOWS_ICON)
    const { file } = packPackage({ srcDir: src, outRoot: out, manifestText: json() })
    expect(archiveEntryNames(file)).toContain(WINDOWS_ICON_NAME)
    expect([...readArchiveEntry(file, WINDOWS_ICON_NAME)!.subarray(0, 4)]).toEqual([0, 0, 1, 0])
    // icon.ico 不是第二张图标：包根仍只有那张源图，注册也认这份包
    const registered = registerPackageAt(file)
    expect(registered.problems, '自备 icon.ico 的包该注册得过').toEqual([])
  })
})
