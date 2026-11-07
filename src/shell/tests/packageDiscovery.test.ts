import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { badAppId, notRegistered } from '@airship/contract'
import { DEFAULT_ENTRY, MANIFEST_NAME, PACKAGE_ROOT_LABEL, PACKAGE_SUFFIX } from '@airship/contract'
import { archiveEntryNames, normalizeEntryName } from '../main/services/packageArchive'
import { scanPackages } from '../main/services/packageRegistry'
import { packageRoots } from '../main/services/packageRoots'
import {
  installPackageAt,
  installRawPackage,
  packageArchivesIn,
  packageFixtureRoot,
  writeArchive,
  writeFixturePackages
} from './helpers/packages'
import { REAL_APPS, manifestOf } from './helpers/realApps'
import type { InstalledPackage } from '../main/services/packageRegistry'

/**
 * PK-008 ~ PK-014：壳在运行期扫包，以及包的文档面。
 *
 * 这一族钉的是"改一个应用不用重出安装包"成立所依赖的那几条前提：
 * 谁占住一个 id、坏包会不会压好包、暂存归档算不算、改了名字还在不在、发布版认不认那个环境变量。
 * 安装包是纯壳，所以根只有两个：开发根与自装根。
 *
 * 用例直接喂 `scanPackages(roots)`——它不碰 Electron，也不碰注册表的模块状态，
 * 所以三个根的局面可以原样摆出来。协议那一档（PK-014）同理：解析条目是纯函数。
 */

let dev = ''
let installed = ''

beforeEach(() => {
  dev = writeFixturePackages(packageFixtureRoot())
  installed = join(packageFixtureRoot(), '..', `airship-installed-${process.pid}`)
  rmSync(installed, { recursive: true, force: true })
  mkdirSync(installed, { recursive: true })
})

function roots() {
  return [
    { dir: dev, origin: 'dev' as const },
    { dir: installed, origin: 'installed' as const },
  ]
}

const life = () => REAL_APPS.find((m) => m.id === 'life')!
const ids = (list: InstalledPackage[]): string[] => list.map((p) => p.meta.id).sort()

describe('壳在运行期扫包认应用', () => {
  it('PK-008 同 id 时先扫到的那份占住，被遮住的写清是谁压了谁', () => {
    installPackageAt(installed, life())
    // 把 dev 根里那一份改个名，才知道生效的是哪一份
    const archive = join(dev, `life${PACKAGE_SUFFIX}`)
    const manifest = JSON.parse(archiveEntryText(archive, MANIFEST_NAME)) as Record<string, unknown>
    writeArchive(archive, { ...entryMap(dev, 'life'), [MANIFEST_NAME]: JSON.stringify({ ...manifest, name: 'dev 那一份' }) })

    const scan = scanPackages(roots())
    const holders = scan.packages.filter((p) => p.meta.id === 'life')
    expect(holders.length, '同 id 在注册表里只有一条').toBe(1)
    expect(holders[0]!.meta.name).toBe('dev 那一份')
    expect(holders[0]!.origin).toBe('dev')

    const shadowed = scan.problems.filter((p) => p.reason.includes('同一个 id 已经有包了'))
    expect(shadowed.length, scan.problems.map((p) => p.reason).join('\n')).toBe(1)
    expect(shadowed[0]!.at).toBe(join(installed, `life${PACKAGE_SUFFIX}`))
    // 「来自哪个根」那句的措辞只有一处真源（PACKAGE_ROOT_LABEL），用例不在这里再抄一遍字
    expect(shadowed[0]!.reason).toContain(`来自${PACKAGE_ROOT_LABEL.dev}的`)
  })

  it('PK-009 坏包不占名：不合格的那一份压不住能用的那一份', () => {
    // 高优先级的 dev 根里塞一个清单读不出来的同名归档，能用的那份留在自装根
    rmSync(join(dev, `life${PACKAGE_SUFFIX}`), { force: true })
    installRawPackage(dev, `life${PACKAGE_SUFFIX}`, '{ id:')
    installPackageAt(installed, life())

    const scan = scanPackages(roots())
    expect(ids(scan.packages), '坏包压不住能用的包').toContain('life')
    expect(scan.packages.find((p) => p.meta.id === 'life')!.archive).toBe(join(installed, `life${PACKAGE_SUFFIX}`))
    expect(scan.problems.some((p) => p.at === join(dev, `life${PACKAGE_SUFFIX}`) && p.reason.includes('解析失败'))).toBe(true)
  })

  it('PK-010 暂存与备份归档不算包，非包文件也不算', () => {
    installRawPackage(dev, `life${PACKAGE_SUFFIX}.tmp-123`, '{}')
    installRawPackage(dev, `life${PACKAGE_SUFFIX}.prev-456`, '{}')
    mkdirSync(join(dev, 'specs'), { recursive: true })
    writeFileSync(join(dev, 'loose.txt'), '不算包', 'utf8')

    const scan = scanPackages(roots())
    expect(scan.packages.filter((p) => p.meta.id === 'life').length, '暂存归档不该多占一个 id').toBe(1)
    expect(scan.packages.every((p) => p.archive.endsWith(PACKAGE_SUFFIX)), '每个扫出来的都要以 .airship 结尾').toBe(true)
    expect(scan.problems, '暂存归档不是包，也就不该产生报错').toEqual([])
    expect(existsSync(join(dev, `life${PACKAGE_SUFFIX}`)), '原来那个包不该被动过').toBe(true)
    // 两个暂存名确实在包根里，只是不算包
    expect(readdirSync(dev).filter((n) => /\.airship\.(tmp|prev)-/.test(n)).length).toBe(2)
    expect(packageArchivesIn(dev).filter((n) => n.includes('.tmp-') || n.includes('.prev-'))).toEqual([])
  })

  it('PK-011 没装进来的原因落得下来，形状是"哪个归档 + 为什么"', () => {
    // 清单 id 不合形状：整条原因要能指到那个归档
    installRawPackage(
      dev,
      `life${PACKAGE_SUFFIX}`,
      JSON.stringify({ ...manifestOf(life()), id: '生命游戏' })
    )

    const scan = scanPackages(roots())
    expect(ids(scan.packages), '坏包不进表').not.toContain('life')
    expect(scan.problems.length).toBeGreaterThan(0)
    const problem = scan.problems.find((p) => p.at.includes(`life${PACKAGE_SUFFIX}`))!
    expect(problem.reason, '原因要念出 id 形状那一句').toContain(badAppId('生命游戏').slice(0, 14))
    expect(problem.at, 'at 是要落日志的归档路径，不能是空串').toBeTruthy()

    // 一个都没扫到：packages 空数组，主进程那句"一个应用都没装进来"就靠它
    const none = scanPackages([{ dir: join(dev, '不存在'), origin: 'dev' }])
    expect(none.packages).toEqual([])
  })

  it('PK-012 发布版忽略 AIRSHIP_APPS_ROOT，开发版才认', () => {
    const env = { AIRSHIP_APPS_ROOT: dev, LOCALAPPDATA: 'C:\\Users\\xyzwp\\AppData\\Local' }
    const base = { env, userDataDir: 'C:\\Users\\xyzwp\\AppData\\Roaming\\airship' }

    const running = packageRoots({ ...base, isPackaged: false })
    expect(running[0]!.origin).toBe('dev')
    expect(running[0]!.dir).toBe(dev)

    const shipped = packageRoots({ ...base, isPackaged: true })
    expect(shipped.map((r) => r.origin), '装好的壳不认这个变量：不然一个 env 就是路径注入面').toEqual(['installed'])
    expect(shipped[0]!.dir).toBe('C:\\Users\\xyzwp\\AppData\\Local\\airship\\apps')

    // 非 Windows 上没有 LOCALAPPDATA：自装根退回用户数据目录旁边，不能凭空少一个根
    const mac = packageRoots({
      env: {},
      userDataDir: '/u/Library/Application Support/airship',
      isPackaged: true
    })
    expect(mac.map((r) => r.origin), '非 Windows 上也只有自装根这一个').toEqual(['installed'])
    expect(mac[0]!.dir).toBe(join('/u/Library/Application Support/airship', 'airship', 'apps'))
  })

  it('PK-013 改了归档名，重启后格子里就没有它', () => {
    const before = scanPackages(roots())
    expect(ids(before.packages)).toContain('life')

    renameSync(join(dev, `life${PACKAGE_SUFFIX}`), join(dev, `life-old${PACKAGE_SUFFIX}`))
    const after = scanPackages(roots())
    expect(ids(after.packages), '改了名字的归档不再是那个 id').not.toContain('life')
    // 改名不是错误，但会冒出一条"清单 id 与包名不一致"的原因——它也得看得见
    const mismatch = after.problems.filter((p) => p.at.includes(`life-old${PACKAGE_SUFFIX}`) && p.reason.includes('与目录名'))
    expect(mismatch.length, '改了名字的归档要冒出一条"清单 id 与包名不一致"的原因').toBe(1)

    // 壳与安装包一个字都没动过——这条判据只碰了文件名
    writeFixturePackages(dev)
    expect(ids(scanPackages(roots()).packages)).toContain('life')
  })

  it('PK-014 airship:// 越界与没装进来各有各的原话，都拿不到包外的东西', async () => {
    vi.resetModules()
    vi.doMock('electron', () => ({
      protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined }
    }))
    const { resolvePackageEntry } = await import('../main/services/packageProtocol')

    const pkg = scanPackages(roots()).packages.find((p) => p.meta.id === 'life')!
    const lookup = (id: string) => (id === 'life' ? { archive: pkg.archive, entry: DEFAULT_ENTRY } : null)

    // 没装进来的 id：与窗口那侧同一句原话，渲染侧不许再拼一套
    expect(resolvePackageEntry('airship://ghost/index.html', lookup)).toEqual({ reason: notRegistered('ghost') })

    // 越界的两种写法：字面 .. 与被编码的 %2e%2e。URL 解析器自己会把它们归一掉（实测），
    // 所以这里钉的是"解不出包外条目"这个结果，而不是某一句具体措辞。
    for (const url of ['airship://life/../../windows/win.ini', 'airship://life/%2e%2e/%2e%2e/windows/win.ini']) {
      const got = resolvePackageEntry(url, lookup)
      // URL 解析器自己把 .. 与 %2e%2e 归一掉了（实测），所以解出来的名字必然还在包内；
      // 钉的是这一条：不管从哪条路进来，都拿不到包外的条目
      if ('name' in got) {
        expect(got.name, `${url} 解出的条目名不许带 ..`).not.toContain('..')
        expect(archiveEntryNames(pkg.archive), `${url} 解出的条目不该真的存在`).not.toContain(got.name)
      } else {
        expect((got as { reason: string }).reason).toContain('win.ini')
      }
    }

    // 那道闸自己也要能拦：归一化挡不住的写法直接喂进去
    expect(normalizeEntryName('../../windows/win.ini')).toBeNull()
    expect(normalizeEntryName('..\\..\\windows\\win.ini'), '反斜杠的写法也不放行').toBeNull()
    expect(normalizeEntryName('assets/index.js'), '包内的正常相对路径要放行').toBe('assets/index.js')

    expect(resolvePackageEntry('airship://life/index.html', lookup)).toEqual({
      archive: pkg.archive,
      name: DEFAULT_ENTRY
    })
    expect(resolvePackageEntry('airship://life/', lookup), '空路径落到入口文档').toEqual({
      archive: pkg.archive,
      name: DEFAULT_ENTRY
    })
    // 包里没有的条目名照样解得出名字，但"存不存在"由读归档那一步回答
    expect(resolvePackageEntry('airship://life/nope.js', lookup)).toEqual({ archive: pkg.archive, name: 'nope.js' })
    expect(archiveEntryNames(pkg.archive)).not.toContain('nope.js')
  })

  it('PK-011b 这些原因真的落进日志，一句都不必用户去猜', async () => {
    vi.resetModules()
    const logRoot = join(packageFixtureRoot(), '..', `airship-log-${process.pid}`)
    const local = join(packageFixtureRoot(), '..', `airship-local-${process.pid}`)
    rmSync(logRoot, { recursive: true, force: true })
    rmSync(local, { recursive: true, force: true })
    mkdirSync(logRoot, { recursive: true })
    // 自装根住在 %LOCALAPPDATA%\airship\apps 下：用假的 LOCALAPPDATA 把整条路挪进临时目录
    installPackageAt(join(local, 'airship', 'apps'), life())
    // 坏包放在优先级更高的 dev 根里——它要进不了表，也要留下一条原因
    rmSync(join(dev, `life${PACKAGE_SUFFIX}`), { force: true })
    installRawPackage(dev, `life${PACKAGE_SUFFIX}`, '{ id:')

    const savedLocal = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = local
    vi.doMock('electron', () => ({
      app: { getPath: () => logRoot, getVersion: () => '0.0.0-test', isPackaged: false },
      protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
      net: {},
      ipcMain: { handle: () => undefined, on: () => undefined }
    }))
    try {
      const { scanInstalledPackages, packageProblemLines, appIds } = await import('../main/services/appRegistry')
      const { logDir } = await import('../main/services/paths')

      const installedNow = scanInstalledPackages()
      expect(appIds(), '坏包压不住自装根里那份能用的').toContain('life')
      expect(installedNow.find((p) => p.meta.id === 'life')!.origin).toBe('installed')
      expect(packageProblemLines().length, '坏包那条原因要在读得到的地方').toBeGreaterThan(0)

      const logs = logDir()
      const files = readdirNames(logs)
        .filter((n) => n.startsWith('airship-') && n.endsWith('.log'))
        .map((n) => join(logs, n))
      expect(files.length, '日志按天分文件，这里该有一份').toBeGreaterThan(0)
      const text = readFileSync(files[0]!, 'utf8')
      expect(text).toContain('这个包没装进来')
      expect(text).toContain('装进壳的包')
    } finally {
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = savedLocal
      rmSync(local, { recursive: true, force: true })
    }
  })

  it('PK-011c 一个应用都没有时，日志把找过的包根都念出来', async () => {
    vi.resetModules()
    const logRoot = join(packageFixtureRoot(), '..', `airship-log-empty-${process.pid}`)
    const local = join(packageFixtureRoot(), '..', `airship-local-empty-${process.pid}`)
    for (const p of [logRoot, local]) {
      rmSync(p, { recursive: true, force: true })
      mkdirSync(p, { recursive: true })
    }

    const savedLocal = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = local
    vi.doMock('electron', () => ({
      app: { getPath: () => logRoot, getVersion: () => '0.0.0-test', isPackaged: true },
      protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
      net: {},
      ipcMain: { handle: () => undefined, on: () => undefined }
    }))
    try {
      const { scanInstalledPackages, appIds } = await import('../main/services/appRegistry')
      const { logDir } = await import('../main/services/paths')

      expect(scanInstalledPackages()).toEqual([])
      expect(appIds()).toEqual([])
      const logs2 = logDir()
      const file = readdirNames(logs2)
        .filter((n) => n.endsWith('.log'))
        .map((n) => join(logs2, n))[0]!
      const text = readFileSync(file, 'utf8')
      expect(text, '空表要喊出来，不然用户只看见一屏空白').toContain('一个应用都没装进来')
      // 详情是 JSON 落的一行，把它解出来比对——搜原文会被转义的反斜杠骗到
      const line = text.split('\n').find((l) => l.includes('一个应用都没装进来'))!
      const payload = JSON.parse(line.slice(line.indexOf('{'))) as { 找过的包根: string[] }
      expect(payload.找过的包根, '连找过哪儿都得不出来就没法查').toEqual([join(local, 'airship', 'apps')])
    } finally {
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = savedLocal
      rmSync(local, { recursive: true, force: true })
    }
  })
})

/* ---------------- 小工装 ---------------- */

function readdirNames(dir: string): string[] {
  return readdirSync(dir)
}

/** 读归档里某个条目的文本（造"改名/换内容"那种局面时用） */
function archiveEntryText(archive: string, name: string): string {
  const out = unzipSync(new Uint8Array(readFileSync(archive)), { filter: (f) => f.name === name })
  if (out[name] === undefined) throw new Error(`${archive} 里没有 ${name}`)
  return strFromU8(out[name])
}

/** 把一个归档里的条目原样搬到另一个归档名下（改清单内容用） */
function entryMap(root: string, id: string): Record<string, string | Uint8Array> {
  const file = join(root, `${id}${PACKAGE_SUFFIX}`)
  const all = unzipSync(new Uint8Array(readFileSync(file)))
  const out: Record<string, string | Uint8Array> = {}
  for (const [name, bytes] of Object.entries(all)) out[name] = bytes
  return out
}
