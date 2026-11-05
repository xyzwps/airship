import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { componentProblem, iconProblems, manifestProblems } from '../../shared/registryRules'
import { platformIssue } from '../../shared/errors'
import { PLATFORM_IDS, TOOL_NAMES } from '../../shared/protocol'
import { APP_ENTRIES, APPS, entriesAvailableOn } from '../../apps'
import type { AppMeta } from '@shared/app'

/**
 * AP-001 ~ AP-011：一个应用的对外形状与发现规矩。
 *
 * 校验规则被抽成 shared/registryRules 那份纯函数（主进程与渲染侧都调它），
 * 所以"缺一件就炸"能拿合成输入验，不必真去改目录树；
 * 而"两侧看的是同一批清单""用到的域都声明过"这两条对着**真磁盘与真源码**扫。
 */

const APPS_DIR = join(__dirname, '..', '..', 'apps')

function meta(over: Partial<AppMeta> & { id: string }): AppMeta {
  return {
    id: over.id,
    name: over.name ?? over.id,
    description: '测试',
    accent: '#fff',
    capabilities: [],
    ...over
  } as AppMeta
}

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue
      out.push(...sources(p))
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p)
    }
  }
  return out
}

describe('缺一件就在注册期说清', () => {
  it('AP-001 缺清单、缺组件入口都点名的报出来', () => {
    expect(manifestProblems('apps/foo/app.ts', 'foo', undefined, [])).toEqual(['apps/foo/app.ts: 没导出 app'])
    expect(componentProblem('foo')).toBe('foo: 缺组件入口 ./apps/foo/index.tsx')
  })

  it('AP-002 图标有且只能有一张', () => {
    expect(iconProblems('foo', [])[0]).toContain('缺图标 apps/foo/icon.svg（也接受 png / jpg / jpeg / webp）')
    const two = iconProblems('foo', ['./foo/icon.svg', './foo/icon.png'])
    expect(two[0]).toBe('foo: 图标有多张，只留一张：./foo/icon.svg, ./foo/icon.png')
    expect(iconProblems('foo', ['./foo/icon.svg'])).toEqual([])
  })

  it('AP-003 清单 id 必须等于目录名，两侧同一份规则', () => {
    const bad = manifestProblems('apps/foo/app.ts', 'foo', meta({ id: 'bar', name: 'x' }), [])
    expect(bad).toEqual(['apps/foo/app.ts: 清单 id "bar" 与目录名 "foo" 不一致'])
  })

  it('AP-004 id 重复被拒', () => {
    // 目录名对得上、但 id 已经被别人占了
    const dup = manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A' }), ['a'])
    expect(dup).toEqual(['apps/a/app.ts: id 重复 "a"'])
    // 目录名与 id 都不对时，两条原因一起说
    expect(manifestProblems('apps/b/app.ts', 'b', meta({ id: 'a', name: 'B' }), ['a'])).toEqual([
      'apps/b/app.ts: 清单 id "a" 与目录名 "b" 不一致',
      'apps/b/app.ts: id 重复 "a"'
    ])
  })
})

describe('清单只写应用自己的事实', () => {
  it('AP-005 清单里不写壳不认识的工具', () => {
    const bad = manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', tools: ['ffmpeg', 'nope'] as never }), [])
    expect(bad[0]).toContain('壳不认识的工具')
    expect(bad[0]).toContain('nope')
    // 真清单里一个越界的都没有
    for (const m of APPS) {
      for (const t of m.tools ?? []) expect(TOOL_NAMES).toContain(t)
    }
  })

  it('AP-006 平台字段只用认识的名字，不写就是全平台', () => {
    expect(manifestProblems('apps/a/app.ts', 'a', meta({ id: 'a', name: 'A', platforms: ['win'] as never }), [])).toEqual([
      'apps/a/app.ts: 不认识的平台 "win"（清单 platforms 只认 windows / macos / linux）'
    ])

    // 不写 platforms：任何平台都判为可用
    expect(platformIssue(meta({ id: 'a', name: 'A' }), 'linux')).toBeNull()
    expect(platformIssue(meta({ id: 'a', name: 'A', platforms: [] }), 'macos')).toBeNull()

    // 写了：平台对上才可用，对不上要说清它在哪些平台可用、这台机器是什么
    const only = meta({ id: 'wsld', name: '容器台', platforms: ['windows'] })
    expect(platformIssue(only, 'windows')).toBeNull()
    expect(platformIssue(only, 'macos')).toBe('它只在 windows 上可用，这台机器是 macos')
    expect(platformIssue(only, 'unknown')).toContain('这台机器是 unknown')

    for (const m of APPS) {
      for (const p of m.platforms ?? []) expect(PLATFORM_IDS).toContain(p)
    }
  })

  it('AP-007 清单里没有图标字段，也没有顺序字段', () => {
    const fields = Object.keys(meta({ id: 'a', name: 'A' }))
    expect(fields).not.toContain('iconPath')
    expect(fields).not.toContain('icon')
    expect(fields).not.toContain('order')

    // 类型源码里也不给这两个字段开后门
    const type = readFileSync(join(__dirname, '..', '..', 'shared', 'app.ts'), 'utf8')
    expect(type).not.toMatch(/^\s*icon\??:/m)
    expect(type).not.toMatch(/^\s*order\??:/m)

    // 图标是文件约定：真目录里每张 icon.* 都在
    for (const id of Object.keys(APP_ENTRIES)) {
      const icons = readdirSync(join(APPS_DIR, id)).filter((n) => /^icon\.(svg|png|jpe?g|webp)$/.test(n))
      expect(icons.length, `${id} 的图标应当有且只有一张`).toBe(1)
    }
  })
})

describe('两侧看的是同一批清单', () => {
  const { appIds, appsInOrder } = { appIds: Object.keys(APP_ENTRIES), appsInOrder: APPS.map((m) => m.name) }

  it('AP-008 主进程与渲染侧发现的应用集合一致，且等于磁盘上的目录', async () => {
    const main = await import('../main/services/appRegistry')
    const fromMain = main.appIds().sort()
    const fromDisk = readdirSync(APPS_DIR)
      .filter((n) => statSync(join(APPS_DIR, n)).isDirectory() && existsSync(join(APPS_DIR, n, 'app.ts')))
      .sort()
    expect(fromMain).toEqual(fromDisk)
    expect(Object.keys(APP_ENTRIES).sort()).toEqual(fromDisk)
  })

  it('AP-009 显示顺序由壳按名字典序定，两侧一致', async () => {
    const main = await import('../main/services/appRegistry')
    const mainOrder = main.appsInOrder().map((m) => m.name)
    const rendererOrder = Object.values(APP_ENTRIES).map((e) => e.meta.name)
    const sorted = [...mainOrder].sort((a, b) => a.localeCompare(b, 'zh'))
    expect(mainOrder).toEqual(sorted)
    expect(rendererOrder).toEqual(sorted)
    void appsInOrder
    void appIds
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
    for (const [id, entry] of Object.entries(APP_ENTRIES)) {
      const dir = join(APPS_DIR, id)
      const code = sources(dir)
        .map((f) => readFileSync(f, 'utf8'))
        .join('\n')
      const declared = new Set(entry.meta.capabilities as string[])

      for (const [domain, required] of Object.entries(needs)) {
        if (new RegExp(`api\\.${domain}\\.`).test(code)) {
          for (const cap of required) expect(declared.has(cap), `${id} 用了 api.${domain} 却没声明 ${cap}`).toBe(true)
        }
      }

      // 读写分别核对
      if (/api\.fs\.(read|readRange|stat|list)\(/.test(code)) expect(declared.has('fs.read'), `${id} 缺 fs.read`).toBe(true)
      if (/api\.fs\.(write|ensureDir|remove|copy)\(/.test(code)) expect(declared.has('fs.write'), `${id} 缺 fs.write`).toBe(true)
      if (/resolveInShared\(\s*['"]([a-z]+)/.test(code)) {
        const ns = code.match(/resolveInShared\(\s*['"]([a-z]+)/)![1]!
        expect(declared.has('shared'), `${id} 用共享区却没声明 shared`).toBe(true)
        expect(entry.meta.sharedNamespaces ?? [], `${id} 没用声明 ${ns}`).toContain(ns)
      }

      // 问了哪个工具，清单里就得写哪个
      for (const m of code.matchAll(/tools\.path\(\s*['"]([a-z]+)['"]/g)) {
        expect(entry.meta.tools ?? [], `${id} 用了 ${m[1]} 却没在清单 tools 里写`).toContain(m[1])
      }
    }
  })

  it('AP-006b 启动器的格子按平台过滤：不写的都在，写了的对不上就不在', () => {
    const onWindows = entriesAvailableOn('windows').map((e) => e.meta.id)
    const onLinux = entriesAvailableOn('linux').map((e) => e.meta.id)

    for (const [id, entry] of Object.entries(APP_ENTRIES)) {
      const wanted = entry.meta.platforms
      if (!wanted || wanted.length === 0) {
        expect(onWindows, `${id} 没写 platforms，Windows 上必须可见`).toContain(id)
        expect(onLinux, `${id} 没写 platforms，Linux 上必须可见`).toContain(id)
        continue
      }
      const visible = (platform: 'windows' | 'linux'): boolean =>
        (platform === 'windows' ? onWindows : onLinux).includes(id)
      expect(visible('windows'), `${id} 声明了 ${wanted.join('/')}`).toBe(wanted.includes('windows'))
      expect(visible('linux'), `${id} 声明了 ${wanted.join('/')}`).toBe(wanted.includes('linux'))
    }
  })
})
