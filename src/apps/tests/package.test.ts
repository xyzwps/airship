import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  APP_ID_PATTERN,
  MANIFEST_NAME,
  SCHEMA_VERSION,
  idShapeProblem,
  layoutProblems,
  manifestProblems,
  pack,
  referenceProblems
} from '../../../code/pack-app.mjs'
import { badAppId } from '@airship/contract'
import { APP_ID_PATTERN as SHELL_APP_ID_PATTERN } from '@airship/contract'
import { manifestProblems as registryManifestProblems } from '@airship/contract'
import { REAL_APPS } from '../../shell/tests/helpers/realApps'
import { DEFAULT_ENTRY } from '@airship/contract'
import { archiveEntryNames, readArchiveText } from '../../shell/main/services/packageArchive'

/**
 * PK-001 ~ PK-007：一个 airship 包在磁盘上的形状。
 *
 * 契约在 src/apps/specs/package.md，影子在这里。
 * 产包器是 code/pack-app.mjs（Node 直接跑，不吃本仓 TS），
 * 所以壳侧那份 id 规矩（src/shared/app.ts 的 APP_ID_PATTERN 与 shared/errors 的那句话）
 * 与产包器里的一份**必须由用例钉成相等**——靠注释里写"记得同步"是会分叉的。
 *
 * 产物一律落在系统临时目录，不留进仓库（AGENTS.md 的本机事实）。
 */

let work = ''

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
  for (const icon of options?.icons ?? ['icon.svg']) writeFileSync(join(dir, icon), '<svg/>', 'utf8')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'main.js'), 'console.log(1)', 'utf8')
  writeFileSync(join(dir, 'assets', 'styles.css'), 'body{margin:0}', 'utf8')
  for (const [name, text] of Object.entries(options?.extraFiles ?? {})) writeFileSync(join(dir, name), text, 'utf8')
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

describe('包是一个自带清单的目录，名字由 id 定', () => {
  it('PK-001 id 不合形状时把规则念出来，且产包器与壳侧判的是同一条', () => {
    for (const bad of ['墨读', 'Life', 'a b', 'a%20b', 'a#b', '-demo', 'demo.v2', 'x'.repeat(33)]) {
      expect(manifestProblems({ ...goodManifest, id: bad }), `id ${JSON.stringify(bad)} 该被拒`).not.toEqual([])
    }
    for (const ok of ['a', 'life', 'gosper-gun', 'x'.repeat(32)]) {
      expect(manifestProblems({ ...goodManifest, id: ok }), `id ${ok} 该收下`).toEqual([])
    }

    // 两份文案与两份正则都必须逐字相同：Node 跑不了本仓 TS，所以只能靠用例钉住
    expect(idShapeProblem('墨读')).toBe(badAppId('墨读'))
    expect(APP_ID_PATTERN.source).toBe(SHELL_APP_ID_PATTERN.source)
    const fromShell = registryManifestProblems(
      'apps/墨读/app.ts',
      '墨读',
      { id: '墨读', name: '墨读', description: '', capabilities: [] },
      []
    )
    expect(fromShell).toEqual([`apps/墨读/app.ts: ${badAppId('墨读')}`])

    // 现有六个应用的 id 全部通过这一条
    for (const meta of REAL_APPS) expect(APP_ID_PATTERN.test(meta.id), `${meta.id} 该合形状`).toBe(true)
  })

  it('PK-002 缺清单或清单不是合法 JSON，失败并点名，不写半成品目录', () => {
    const src = fixture()
    const out = outRoot()

    expect(() => pack({ srcDir: src, outRoot: out })).toThrow(/manifest\.json 不存在/)
    expect(() => pack({ srcDir: src, outRoot: out, manifestText: '{ id:' })).toThrow(/manifest\.json 解析失败/)
    expect(readdirSync(out), '包根里不该出现半成品').toEqual([])
  })

  it('PK-003 包格式对不上壳认的那一档就拒，sdkVersion 缺了也拒', () => {
    expect(manifestProblems({ ...goodManifest, schemaVersion: 2 })).toContain(
      `包清单 schemaVersion 只认 ${SCHEMA_VERSION}，收到 2（包格式与壳不同档时别硬装，先对齐壳的版本）`
    )

    const noSdk = manifestProblems(JSON.parse(json(undefined, ['sdkVersion'])))
    expect(noSdk.some((p: string) => p.includes('sdkVersion')), noSdk.join('\n')).toBe(true)
  })
})

describe('包清单只写应用自己的事实', () => {
  it('PK-004 图标是文件不是字段：字段被拒，缺一张或多一张也被拒', () => {
    expect(manifestProblems({ ...goodManifest, iconPath: 'icon.svg' })[0]).toContain('图标是包根那一张文件')
    expect(manifestProblems({ ...goodManifest, order: 3 })[0]).toContain('顺序由壳按名字典序定')

    const none = layoutProblems({ fileNames: ['index.html'], manifest: goodManifest })
    expect(none[0]).toContain('缺图标 icon.svg')

    const two = layoutProblems({ fileNames: ['index.html', 'icon.svg', 'icon.png'], manifest: goodManifest })
    expect(two[0]).toBe('包里的图标有多张，只留一张：icon.svg, icon.png')
  })

  it('PK-005 壳不认的键、不像话的值，都点名到字段与收到的东西', () => {
    expect(manifestProblems({ ...goodManifest, capabilitis: [] })).toContain(
      '包清单有壳不认的键 "capabilitis"（要么拼错，要么包格式与壳不同档）'
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

  it('PK-007 装包失败时旧包原样还在，磁盘上没有 .tmp- 或 .prev- 残留', () => {
    const out = outRoot()
    const good = fixture()
    const first = pack({ srcDir: good, outRoot: out, manifestText: json() })
    const before = readdirSync(out)
    const beforeHtml = readArchiveText(first.file, DEFAULT_ENTRY)

    const bad = fixture({ html: '<script src="https://cdn.example/app.js"></script>' })
    expect(() => pack({ srcDir: bad, outRoot: out, manifestText: json({ id: 'demo.v2' }) })).toThrow(/不合形状/)
    expect(() => pack({ srcDir: bad, outRoot: out, manifestText: json() })).toThrow(/包不合格/)

    expect(readdirSync(out), '包根只剩那个旧包').toEqual(before)
    expect(readArchiveText(first.file, DEFAULT_ENTRY), '旧包的入口文档一个字节都没变').toBe(beforeHtml)
    expect(
      readdirSync(out).some((n) => /\.airship\.(tmp|prev)-/.test(n)),
      '不许留半成品'
    ).toBe(false)
  })

  it('PK-007b 清单把 entry 指到包里不存在的那个名字，也是响亮失败', () => {
    const out = outRoot()
    pack({ srcDir: fixture(), outRoot: out, manifestText: json() })
    const before = readdirSync(out)

    expect(() => pack({ srcDir: fixture(), outRoot: out, manifestText: json({ entry: 'page.html' }) })).toThrow(
      /包里没有入口文件 page\.html/
    )
    expect(readdirSync(out), '旧包不受影响').toEqual(before)
  })
})
