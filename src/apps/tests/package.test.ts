import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_ID_PATTERN,
  BACKEND_ENTRY_PATTERN,
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
import { WINDOWS_ICON_NAME as CONTRACT_WINDOWS_ICON_NAME } from '@airship/contract'
import { BACKEND_ENTRY_PATTERN as CONTRACT_BACKEND_ENTRY_PATTERN } from '@airship/contract'
import { badAppId } from '@airship/contract'
import { APP_ID_PATTERN as CONTRACT_APP_ID_PATTERN } from '@airship/contract'
import { manifestProblems as registryManifestProblems } from '@airship/contract'
import { packageManifestProblems } from '@airship/contract'
import { REAL_APPS } from '../../runtime/tests/helpers/realApps'
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

/** 包根那张源图在用例里的样子：产包期要把它转成外壳认的 icon.ico，所以得是能渲染的 SVG */
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>'

/** 一个够格的产物目录：入口 + 图标 + 一份相对引用的资产 */
function fixture(options?: { html?: string; icons?: string[]; extraFiles?: Record<string, string> }): string {
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

    // 派生那份 icon.ico（PK-036）不算第二张图标：它是产物，外壳只认磁盘上的 .ico
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

describe('清单可以指一个随包自带的后台程序入口', () => {
  it('PK-037 backend 形状不对两侧都点名，且原因列表逐字相同', () => {
    // 两侧的正则必须是同一条判据
    expect(BACKEND_ENTRY_PATTERN.source).toBe(CONTRACT_BACKEND_ENTRY_PATTERN.source)

    for (const bad of [5, '', '   ', 'backend/nope.ts', '/backend/index.js', '../outside/index.js']) {
      const problems = manifestProblems({ ...goodManifest, backend: bad })
      expect(problems.some((p: string) => p.includes('backend')), `${JSON.stringify(bad)} 该被拒：${problems.join('；')}`).toBe(
        true
      )
    }
    for (const ok of ['backend/index.js', 'server.mjs', 'run.cjs']) {
      expect(manifestProblems({ ...goodManifest, backend: ok }), `${ok} 该收下`).toEqual([])
    }

    // 坏清单喂两边，backend 相关的原因列表一字不差（契约侧多带"位置: "前缀，比时剥掉）
    const at = 'apps/demo/app.ts'
    for (const bad of [5, '', 'backend/nope.ts', '/backend/index.js']) {
      const packer = manifestProblems({ ...goodManifest, backend: bad }).filter((p: string) => p.includes('backend'))
      const runtime = packageManifestProblems({ ...goodManifest, backend: bad }, at)
        .map((p: string) => p.slice(at.length + 2))
        .filter((p: string) => p.includes('backend'))
      expect(packer.length, `${JSON.stringify(bad)} 该至少给一条原因`).toBeGreaterThan(0)
      expect(runtime, `${JSON.stringify(bad)} 两侧逐字相同`).toEqual(packer)
    }
  })

  it('PK-038 后端入口文件包里必须有：缺了产包与注册都拒，且一个字节都不动', () => {
    const pointsNowhere = json({ backend: 'backend/index.js' })

    // 产包侧：产物目录里没有那个文件 → 响亮失败，不落任何半成品
    const out = outRoot()
    expect(() => pack({ srcDir: fixture(), outRoot: out, manifestText: pointsNowhere })).toThrow(
      /包里没有后端入口文件 backend\/index\.js（清单 backend 指的就是它在包里的路径）/
    )
    expect(readdirSync(out), '不合格的包一个都不留').toEqual([])

    // 注册侧：归档里缺清单指的那个条目 → 同一句话，字节不动
    const dir = mkdtempSync(join(work, 'reg-'))
    const archive = writeArchive(join(dir, 'pk038.airship'), {
      [MANIFEST_NAME]: json({ id: 'pk038', backend: 'backend/index.js' }),
      [DEFAULT_ENTRY]: '<html></html>',
      'icon.svg': ICON_SVG
    })
    const bytes = readFileSync(archive)
    const res = registerPackageAt(archive)
    expect(res.pkg).toBeUndefined()
    expect(res.problems.join('\n')).toContain(
      '包里没有后端入口文件 backend/index.js（清单 backend 指的就是它在包里的路径）'
    )
    expect(readFileSync(archive).equals(bytes), '被拒的归档字节没变').toBe(true)

    // 有它就放行：产物里带这个条目，包形状完整
    const withBackend = fixture({
      extraFiles: { 'backend/index.js': 'process.parentPort.postMessage({ ready: true })\n' }
    })
    const out2 = outRoot()
    const packed = pack({ srcDir: withBackend, outRoot: out2, manifestText: json({ backend: 'backend/index.js' }) })
    expect(archiveEntryNames(packed.file), '后端入口要进归档').toContain('backend/index.js')
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

describe('包根那份派生的 Windows 外壳图标', () => {
  it('PK-036 产包时把源图转成 icon.ico 放进包根；转不出来不放行包；安装器只取不转', () => {
    // 两处常量必须是同一个名字：产包器写它、runtime 与安装器读它
    expect(WINDOWS_ICON_NAME).toBe(CONTRACT_WINDOWS_ICON_NAME)

    const out = outRoot()
    const { file } = pack({ srcDir: fixture(), outRoot: out, manifestText: json() })
    expect(archiveEntryNames(file), '包根要有派生的那份 ico').toContain(WINDOWS_ICON_NAME)
    const ico = readArchiveEntry(file, WINDOWS_ICON_NAME)
    expect(ico).not.toBeNull()
    // ICO 头部前两档是保留字节 0、类型 1（单图图标）；Pillow 出的是 16~256 七档
    expect([...ico!.subarray(0, 4)]).toEqual([0, 0, 1, 0])
    expect(ico!.length, '多尺寸 ico 不该是个空壳').toBeGreaterThan(1000)

    // 源图渲染不出来 → 产包失败，包根里不留一个"任务栏只能穿 runtime 图标"的包
    const unrenderable = fixture()
    writeFileSync(join(unrenderable, 'icon.svg'), '这不是 svg', 'utf8')
    const out2 = outRoot()
    expect(() => pack({ srcDir: unrenderable, outRoot: out2, manifestText: json() })).toThrow()
    expect(readdirSync(out2), '转不出图标就一个包都不许留下').toEqual([])

    // 图标只在一处生成：安装器（@airship/cli 的 lib/installer.mjs）取包内那一份，不再自己转第二遍
    const installer = readFileSync(join(__dirname, '..', '..', '..', 'src', 'cli', 'lib', 'installer.mjs'), 'utf8')
    expect(installer, '安装器要取包内那份 icon.ico').toContain(WINDOWS_ICON_NAME)
    expect(installer, '转 ico 只许住在产包器一处').not.toContain('app-ico.py')
    expect(readFileSync(join(__dirname, '..', '..', '..', 'code', 'make-app-installer.mjs'), 'utf8'), '仓库驱动也只是取').not.toContain('app-ico.py')
  })

  it('PK-039 仓库外产包：缺 icon.ico 响亮失败，自备了就进包根且不算第二张图标', () => {
    const src = fixture()
    const out = outRoot()
    // 不传 makeWindowsIcon 就是外部作者那条路（@airship/cli 的默认）
    expect(() => packPackage({ srcDir: src, outRoot: out, manifestText: json() })).toThrow(
      '包根没有 icon.ico：任务栏与快捷方式那颗外壳图标只认磁盘上的 .ico'
    )
    expect(readdirSync(out), '缺图标产包不留任何归档').toEqual([])

    writeFileSync(join(src, WINDOWS_ICON_NAME), Buffer.from([0, 0, 1, 0]))
    const { file } = packPackage({ srcDir: src, outRoot: out, manifestText: json() })
    expect(archiveEntryNames(file)).toContain(WINDOWS_ICON_NAME)
    expect([...readArchiveEntry(file, WINDOWS_ICON_NAME)!.subarray(0, 4)]).toEqual([0, 0, 1, 0])
    // icon.ico 不是第二张图标：包根仍只有那张源图，注册也认这份包
    const registered = registerPackageAt(file)
    expect(registered.problems, '自备 icon.ico 的包该注册得过').toEqual([])
  })
})
