import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { iconProblems, manifestProblems } from '@airship/contract'
import { platformIssue } from '@airship/contract'
import { PLATFORM_IDS, TOOL_NAMES } from '@airship/contract'
import { APP_ID_PATTERN } from '@airship/contract'
import { DEFAULT_ENTRY, MANIFEST_NAME, PACKAGE_SUFFIX } from '@airship/contract'
import {
  APPS_DIR,
  REAL_APP_IDS,
  REAL_APPS,
  appSourceProblems,
  manifestProblemsOf
} from './helpers/realApps'
import { packageArchivesIn, packageFixtureRoot, readArchiveEntryText, writeFixturePackages } from './helpers/packages'
import { archiveEntryNames } from '../main/services/packageArchive'
import { loadPackages, packagesAvailableOn, scanPackages } from '../main/services/packageRegistry'
import type { AppMeta } from '@airship/contract'

/**
 * AP-001 ~ AP-012：一个应用的对外形状与发现规矩。
 *
 * 校验规则住在 `shared/registryRules.ts`（产包期、主进程、渲染侧都调它），
 * 所以"缺一件就炸"能拿合成输入验；而"磁盘上的包就是仓库里那批清单"这一条
 * 对着**真磁盘**验：把真清单落成临时包根，让壳自己扫一遍，再比回来。
 *
 * 产品代码里已经没有应用名单了（运行期扫包），所以这份用例自带一个 glob 读真清单
 * ——工装在 `helpers/realApps.ts`，那里写清了它只许住在这里。
 */

function meta(over: Partial<AppMeta> & { id: string; name: string }): AppMeta {
  return {
    description: '测试',
    capabilities: [],
    ...over
  } as AppMeta
}

function sourcesOf(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'tests' || name === 'specs' || name === '__tests__' || name === 'fixtures') continue
      out.push(...sourcesOf(p))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

const root = packageFixtureRoot()

beforeAll(() => {
  writeFixturePackages(root)
  loadPackages([{ dir: root, origin: 'dev' }])
})

describe('缺一件就在注册期说清', () => {
  it('AP-001 缺清单、缺入口、缺图标都点名的报出来', () => {
    expect(manifestProblems('apps/foo/app.ts', 'foo', undefined, [])).toEqual(['apps/foo/app.ts: 没导出 app'])
    // 源码侧的四份文件：清单、入口文档、入口脚本、图标
    for (const id of REAL_APP_IDS) {
      expect(appSourceProblems(id), `${id} 的四份文件该齐`).toEqual([])
    }
  })

  it('AP-002 图标有且只能有一张', () => {
    expect(iconProblems('foo', [])[0]).toContain('缺图标')
    const two = iconProblems('foo', ['./foo/icon.svg', './foo/icon.png'])
    expect(two[0]).toContain('只留一张')
    expect(two[0]).toContain('icon.svg')
    expect(two[0]).toContain('icon.png')
    expect(iconProblems('foo', ['./foo/icon.svg'])).toEqual([])

    // 真包根里每张图标都在，而且只有一张（只看归档根那一层，assets/ 里的不算）
    for (const name of packageArchivesIn(root)) {
      const icons = archiveEntryNames(join(root, name)).filter(
        (n) => !n.includes('/') && /^icon\.(svg|png|jpe?g|webp)$/.test(n)
      )
      expect(icons.length, `${name} 的图标应当有且只有一张`).toBe(1)
    }
  })

  it('AP-003 清单 id 必须等于归档名，产包期与运行期用的是同一份规则', () => {
    const bad = manifestProblems('apps/foo/app.ts', 'foo', meta({ id: 'bar', name: 'x' }), [])
    expect(bad).toEqual(['apps/foo/app.ts: 清单 id "bar" 与目录名 "foo" 不一致'])

    // 磁盘上每个包目录的名字都等于它清单里的 id
    const scanned = scanPackages([{ dir: root, origin: 'dev' }])
    expect(scanned.problems, scanned.problems.map((p) => p.reason).join('\n')).toEqual([])
    expect(scanned.packages.map((p) => p.meta.id).sort()).toEqual(REAL_APP_IDS)
    for (const pkg of scanned.packages) {
      expect(
        pkg.archive.endsWith(`${pkg.meta.id}${PACKAGE_SUFFIX}`),
        `${pkg.meta.id} 的归档名要以 <id>${PACKAGE_SUFFIX} 结尾`
      ).toBe(true)
    }
  })

  it('AP-004 id 重复被拒', () => {
    const dup = manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A' }), ['a'])
    expect(dup).toEqual(['apps/a/app.ts: id 重复 "a"'])
    expect(manifestProblems('apps/b/app.ts', 'b', meta({ id: 'a', name: 'B' }), ['a'])).toEqual([
      'apps/b/app.ts: 清单 id "a" 与目录名 "b" 不一致',
      'apps/b/app.ts: id 重复 "a"'
    ])

    // 仓库里真没有两个清单撞同一个 id
    const ids = REAL_APPS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('清单只写应用自己的事实', () => {
  it('AP-005 清单里不写壳不认识的工具', () => {
    const bad = manifestProblems(
      'apps/a/app.ts',
      'a',
      meta({ id: 'a', name: 'A', tools: ['ffmpeg', 'nope'] as never }),
      []
    )
    expect(bad[0]).toContain('壳不认识的工具')
    expect(bad[0]).toContain('nope')
    for (const m of REAL_APPS) {
      for (const t of m.tools ?? []) expect(TOOL_NAMES).toContain(t)
    }
  })

  it('AP-006 平台字段只用认识的名字，不写就是全平台', () => {
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', platforms: ['win'] as never }), [])).toEqual(
      ['apps/a/app.ts: 不认识的平台 "win"（清单 platforms 只认 windows / macos / linux）']
    )

    expect(platformIssue(meta({ id: 'a', name: 'A' }), 'linux')).toBeNull()
    expect(platformIssue(meta({ id: 'a', name: 'A', platforms: [] }), 'macos')).toBeNull()

    const only = meta({ id: 'wsld', name: '容器台', platforms: ['windows'] })
    expect(platformIssue(only, 'windows')).toBeNull()
    expect(platformIssue(only, 'macos')).toBe('它只在 windows 上可用，这台机器是 macos')
    expect(platformIssue(only, 'unknown')).toContain('这台机器是 unknown')

    for (const m of REAL_APPS) {
      for (const p of m.platforms ?? []) expect(PLATFORM_IDS).toContain(p)
    }
  })

  it('AP-007 清单里没有图标字段，也没有顺序字段', () => {
    const fields = Object.keys(meta({ id: 'a', name: 'A' }))
    expect(fields).not.toContain('iconPath')
    expect(fields).not.toContain('icon')
    expect(fields).not.toContain('order')

    // 类型源码里也不给这两个字段开后门
    const type = readFileSync(join(__dirname, '..', '..', 'shared', 'contract', 'app.ts'), 'utf8')
    expect(type).not.toMatch(/^\s*icon\??:/m)
    expect(type).not.toMatch(/^\s*order\??:/m)

    // 落盘的包清单里同样没有：每个归档里的 manifest.json 都不带这三个键
    for (const name of packageArchivesIn(root)) {
      const text = readArchiveEntryText(join(root, name), MANIFEST_NAME)
      const manifest = JSON.parse(text ?? '{}') as Record<string, unknown>
      expect(Object.keys(manifest).length, `${name} 该有一份读得出的清单`).toBeGreaterThan(0)
      for (const key of ['iconPath', 'icon', 'order']) expect(manifest, `${name} 不该写 ${key}`).not.toHaveProperty(key)
    }
  })

  it('AP-012 默认窗口尺寸必须是正整数，不写就全按壳的默认', () => {
    expect(
      manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultWidth: 900, defaultHeight: 620 }), [])
    ).toEqual([])
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultWidth: 1280 }), [])).toEqual([])
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultWidth: 0 }), [])).toEqual([
      'apps/a/app.ts: 清单 defaultWidth 必须是正整数像素值，收到 0'
    ])
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultHeight: -1 }), [])).toEqual([
      'apps/a/app.ts: 清单 defaultHeight 必须是正整数像素值，收到 -1'
    ])
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultWidth: 900.5 }), [])).toEqual([
      'apps/a/app.ts: 清单 defaultWidth 必须是正整数像素值，收到 900.5'
    ])
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', defaultWidth: 'wide' as never }), [])).toEqual(
      ['apps/a/app.ts: 清单 defaultWidth 必须是正整数像素值，收到 "wide"']
    )

    for (const m of REAL_APPS) {
      for (const key of ['defaultWidth', 'defaultHeight'] as const) {
        const v = m[key]
        if (v !== undefined) expect(Number.isInteger(v) && v > 0, `${m.id} 的 ${key}=${String(v)}`).toBe(true)
      }
    }
  })

  it('AP-015 每个真清单都过同一份包形状判据，id 也过形状判据', () => {
    for (const m of REAL_APPS) {
      expect(APP_ID_PATTERN.test(m.id), `id "${m.id}" 该合形状`).toBe(true)
      expect(manifestProblemsOf(m), `${m.id} 的清单投影成包清单后该零问题`).toEqual([])
    }
  })
})

describe('磁盘上的包就是应用名单', () => {
  it('AP-008 注册表、磁盘、仓库清单三处看到的是同一批', () => {
    const onDisk = packageArchivesIn(root)
      .map((n) => n.slice(0, -PACKAGE_SUFFIX.length))
      .sort()
    const inRegistry = REAL_APP_IDS
    const scanned = scanPackages([{ dir: root, origin: 'dev' }]).packages.map((p) => p.meta.id).sort()
    // 三处一致：仓库里的清单、包根里的目录名、扫出来的注册表
    expect(scanned).toEqual(onDisk)
    expect(scanned).toEqual(inRegistry)
    expect(onDisk.length, '扫到零个包就是工装没铺好，不是"恰好没有"').toBeGreaterThan(0)
  })

  it('AP-009 显示顺序由壳按名字典序定，应用自己说不了话', () => {
    const names = packagesAvailableOn('windows').map((p) => p.meta.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'zh')))
    // 清单里没有 order 这类字段可写（AP-007 已钉），顺序完全由壳定
    for (const m of REAL_APPS) expect(m).not.toHaveProperty('order')
  })

  it('AP-010 加一个应用不改动壳的任何文件', () => {
    // 字面量扫描住在 architecture.test.ts（它才有"壳侧全貌"这份清单），
    // 这里钉的是另一半：每个应用目录该有的四份文件都在，id 与目录名一致
    for (const id of REAL_APP_IDS) {
      expect(appSourceProblems(id), `src/apps/${id}`).toEqual([])
    }
    // 入口文档引的是相对路径的 main.tsx：包搬到哪儿都解得开
    for (const id of REAL_APP_IDS) {
      const html = readFileSync(join(APPS_DIR, id, DEFAULT_ENTRY), 'utf8')
      expect(html, `${id} 的入口 html 要引 ./main.tsx`).toContain('src="./main.tsx"')
    }
  })

  it('AP-011 应用用到的每个契约域，清单里都声明过', () => {
    // 用到的域 → 需要的能力
    const needs: Record<string, string[]> = {
      settings: ['settings'],
      dialog: ['dialog'],
      tray: ['tray'],
      notify: ['notify'],
      clipboard: ['clipboard'],
      log: ['log'],
      proc: ['proc'],
      tools: ['proc']
    }
    for (const m of REAL_APPS) {
      const dir = join(APPS_DIR, m.id)
      const code = sourcesOf(dir)
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
      const declared = new Set(m.capabilities as string[])

      for (const [domain, required] of Object.entries(needs)) {
        if (new RegExp(`api\\.${domain}\\.`).test(code)) {
          for (const cap of required) expect(declared.has(cap), `${m.id} 用了 api.${domain} 却没声明 ${cap}`).toBe(true)
        }
      }

      // 读写分别核对
      if (/api\.fs\.(read|readRange|stat|list)\(/.test(code)) expect(declared.has('fs.read'), `${m.id} 缺 fs.read`).toBe(true)
      if (/api\.fs\.(write|ensureDir|remove|copy)\(/.test(code)) expect(declared.has('fs.write'), `${m.id} 缺 fs.write`).toBe(true)
      if (/resolveInShared\(\s*['"]([a-z]+)/.test(code)) {
        const ns = code.match(/resolveInShared\(\s*['"]([a-z]+)/)![1]!
        expect(declared.has('shared'), `${m.id} 用共享区却没声明 shared`).toBe(true)
        expect(m.sharedNamespaces ?? [], `${m.id} 没声明 ${ns}`).toContain(ns)
      }

      // 问了哪个工具，清单里就得写哪个
      for (const matched of code.matchAll(/tools\.path\(\s*['"]([a-z]+)['"]/g)) {
        expect(m.tools ?? [], `${m.id} 用了 ${matched[1]} 却没在清单 tools 里写`).toContain(matched[1]!)
      }
    }
  })

  it('AP-006b 格子按平台过滤：不写的都在，写了的对不上就不在', () => {
    const onWindows = packagesAvailableOn('windows').map((p) => p.meta.id)
    const onLinux = packagesAvailableOn('linux').map((p) => p.meta.id)

    for (const m of REAL_APPS) {
      const wanted = m.platforms
      if (!wanted || wanted.length === 0) {
        expect(onWindows, `${m.id} 没写 platforms，Windows 上必须可见`).toContain(m.id)
        expect(onLinux, `${m.id} 没写 platforms，Linux 上必须可见`).toContain(m.id)
        continue
      }
      expect(onWindows.includes(m.id), `${m.id} 声明了 ${wanted.join('/')}`).toBe(wanted.includes('windows'))
      expect(onLinux.includes(m.id), `${m.id} 声明了 ${wanted.join('/')}`).toBe(wanted.includes('linux'))
    }
  })
})
