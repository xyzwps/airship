import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ENTRY,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  notRegistered,
  packageRejected,
  sameIdDifferentArchive,
  usageLine
} from '@airship/contract'
import type { AppMeta } from '@airship/contract'
import { installPackageAt, packageFixtureRoot, writeArchive } from './helpers/packages'
import { REAL_APPS, manifestOf } from './helpers/realApps'

/**
 * 直跑一个包：SH-030~033（runtime.md）与 PK-014（package.md）。
 *
 * 命令行解包、注册判定、协议解析三段都是真产品代码：
 * 只把 Electron 换成记账的替身（userData 指到临时目录）。
 * setup.ts 已把仓库真清单注册进活动包表，这里直接拿 life 的真归档做判据。
 * 授权在安装期一次完成（应用安装器欢迎页只念落点与后台两句，PK-033）；直跑不再弹确认卡片，
 * 故这里没有 dialog 卡片的判据——那一族（PK-027~030）已随 runConfirm 退场。
 */

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  const { rmSync: rm, mkdirSync: mk } = await import('node:fs')
  const root = p(__dirname, '.tmp', 'packageRun-userData')
  rm(root, { recursive: true, force: true })
  mk(root, { recursive: true })
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    dialog: { showMessageBoxSync: () => 0 },
    protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
    ipcMain: { handle: () => undefined, on: () => undefined }
  }
})

const { archivesFromArgv } = await import('../main/services/runArgs')
const { registerPackage } = await import('../main/services/appRegistry')
const { packageFor, registerPackageAt, validateArchive } = await import('../main/services/packageRegistry')
const { resolvePackageEntry } = await import('../main/services/packageProtocol')

const life = REAL_APPS.find((m) => m.id === 'airship-life-game')!

/** 造一份最小包清单（直跑判据用，不借任何真应用的名字；id 是产包注入那一步的投影） */
function minimalMeta(id: string): AppMeta & { id: string } {
  const meta: AppMeta = { name: `样件 ${id}`, description: '直跑判据用的最小清单' }
  return { ...meta, id }
}

describe('命令行里挑包', () => {
  it('SH-030 没带包路径启动，念用法，不开界面', () => {
    // 旗标、别的扩展名一概不算包：解出来的列表是空的，一个开窗请求都没有得发
    expect(archivesFromArgv(['airship.exe', '--no-sandbox', 'notes.txt', '--shot'], 'C:/anywhere')).toEqual([])
    expect(archivesFromArgv(['airship.exe'], 'C:/anywhere')).toEqual([])
    expect(usageLine()).toBe(
      'airship runtime 不自己开界面：把一个包的路径交给它（airship.exe <id>.airship），或装一个应用后用它的快捷方式。'
    )
  })

  it('SH-031 相对包路径按交来那一侧的 cwd 解', () => {
    // 第二实例转发：按转发方的 cwd 拼，不是第一实例自己的
    const forwarderCwd = join(tmpdir(), 'airship-forwarder-cwd')
    expect(archivesFromArgv(['airship.exe', `airship-life-game${PACKAGE_SUFFIX}`], forwarderCwd)).toEqual([
      resolve(forwarderCwd, `airship-life-game${PACKAGE_SUFFIX}`)
    ])
    // 快捷方式交来的绝对路径原样保留，不受 cwd 影响
    const absolute = join(packageFixtureRoot(), `airship-life-game${PACKAGE_SUFFIX}`)
    expect(archivesFromArgv(['airship.exe', absolute], 'C:/somewhere/else')).toEqual([absolute])
  })
})

describe('注册失败的包逐条拒', () => {
  it('SH-032 不合格的包逐条拒，不静默少一个窗口', () => {
    const dir = mkdtempSync(join(tmpdir(), 'airship-badpkg-'))
    const broken = writeArchive(join(dir, `broken${PACKAGE_SUFFIX}`), {
      [MANIFEST_NAME]: '{ 残缺',
      'icon.png': '\u0089PNG\r\n\u001a\n'
    })
    const noentry = writeArchive(join(dir, `noentry${PACKAGE_SUFFIX}`), {
      [MANIFEST_NAME]: JSON.stringify({ ...manifestOf(minimalMeta('noentry')), entry: 'page.html' }),
      'icon.png': '\u0089PNG\r\n\u001a\n'
    })

    for (const archive of [broken, noentry]) {
      // 判定与产包期是同一份：抛出来的逐条原因就是 validateArchive 念的那一份
      const problems = validateArchive(archive).problems
      expect(problems.length, `${basename(archive)} 该有问题`).toBeGreaterThan(0)
      let message = ''
      try {
        registerPackage(archive)
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toBe(packageRejected(basename(archive), problems))
      expect(message).toContain(`这个包跑不起来：${basename(archive)}`)
      for (const problem of problems) expect(message).toContain(`  · ${problem}`)
    }
  })

  it('SH-033 同 id 同归档返回表里那一份，异归档拒并念清两份各在哪', () => {
    const active = join(packageFixtureRoot(), `airship-life-game${PACKAGE_SUFFIX}`)
    expect(packageFor('airship-life-game')?.archive).toBe(active)

    // 同一份归档再指一次：还是表里那一份（窗口侧据此聚焦，见 windows.test.ts）
    const again = registerPackageAt(active)
    expect(again.problems).toEqual([])
    expect(again.pkg).toBe(packageFor('airship-life-game'))

    // 同 id 另一份归档：拒，不顶替
    const elsewhere = mkdtempSync(join(tmpdir(), 'airship-other-'))
    const other = installPackageAt(elsewhere, life)
    const res = registerPackageAt(other)
    expect(res.pkg).toBeUndefined()
    expect(res.problems).toEqual([sameIdDifferentArchive('airship-life-game', active, other)])
    expect(res.problems[0]).toContain('先关掉它的窗口再跑这一份。')
    expect(packageFor('airship-life-game')?.archive, '旧归档不许被顶替').toBe(active)
  })
})

describe('airship:// 的可达范围钉死在这一个包里', () => {
  it('PK-014 越界与没注册的读取各有各的原话', () => {
    const lifeArchive = join(packageFixtureRoot(), `airship-life-game${PACKAGE_SUFFIX}`)
    const lookup = (id: string): { archive: string; entry: string } | null =>
      id === 'airship-life-game' ? { archive: lifeArchive, entry: DEFAULT_ENTRY } : null

    // 没注册的 id：念主进程那句原话，不回落入口文档
    expect(resolvePackageEntry('airship://ghost/index.html', lookup)).toEqual({ reason: notRegistered('ghost') })

    // 三种越界写法：都解不出任何包外条目
    for (const url of [
      'airship://airship-life-game/../../windows/win.ini',
      'airship://airship-life-game/%2e%2e/%2e%2e/windows/win.ini',
      'airship://airship-life-game/..\\..\\windows\\win.ini'
    ]) {
      const res = resolvePackageEntry(url, lookup)
      if ('reason' in res) {
        expect(res.reason).toContain('只认包内相对路径')
      } else {
        // URL 把 .. 段折叠后剩下的仍是包内相对名：不含 ..、不带反斜杠、不是绝对路径，
        // 也不是入口文档——归档里没有这个条目，供内容那一步只会 404
        expect(res.archive).toBe(lifeArchive)
        expect(res.name.split('/')).not.toContain('..')
        expect(res.name).not.toContain('\\')
        expect(res.name.startsWith('/')).toBe(false)
        expect(res.name).not.toBe(DEFAULT_ENTRY)
      }
    }
  })
})