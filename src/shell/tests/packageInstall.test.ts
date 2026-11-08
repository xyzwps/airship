import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ENTRY,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  capabilitiesPhrase,
  entryOf,
  notRegistered,
  windowBlocksUninstall
} from '@airship/contract'
import { packageFixtureRoot, writeArchive } from './helpers/packages'
import { REAL_APPS, manifestOf } from './helpers/realApps'
import type { AppMeta } from '@airship/contract'

/**
 * PK-015 ~ PK-025：把包拖进壳里装，以及把它卸掉。
 *
 * 这里测的是这两条链背后主进程干的事：装到哪、什么情况下不装、覆盖为什么要确认，
 * 卸的时候删掉哪一份、什么时候一条字节都不许动。
 * 界面上的句子（"松手就装"、确认卡片、装完与卸完那一行）在 `launcher*.test.tsx` 里钉。
 *
 * 自装根用假的 `LOCALAPPDATA` 挪进临时目录——
 * 装包这条判据必须对着真文件落盘验，只断言"函数被调过"等于没验。
 */

const sandbox = join(packageFixtureRoot(), '..', `airship-install-${process.pid}`)
const local = join(sandbox, 'Local')
const userData = join(sandbox, 'userData')
const installedRoot = join(local, 'airship', 'apps')
/** 待装归档的"源"：拖进来时它在磁盘上的某个别的位置（源与落点是两回事） */
const source = join(sandbox, 'drop-here')

vi.mock('electron', () => ({
  app: {
    getPath: () => userData,
    getVersion: () => '0.0.0-test',
    isPackaged: true
  },
  protocol: { handle: () => undefined, registerSchemesAsPrivileged: () => undefined },
  net: {},
  ipcMain: { handle: () => undefined, on: () => undefined }
}))

const { inspectPackage, installPackage, uninstallPackage } = await import('../main/services/packageInstall')
const { appIds, installedPackages, packageFor, scanInstalledPackages } = await import('../main/services/appRegistry')
const { appBaseDir } = await import('../main/services/paths')
const { grants } = await import('../main/services/grants')
const { resolvePackageEntry } = await import('../main/services/packageProtocol')
const electronApp = (await import('electron')).app as unknown as { isPackaged: boolean }

const life = () => REAL_APPS.find((m) => m.id === 'life')!
const vcp = () => REAL_APPS.find((m) => m.id === 'vcp')!

/** 造一个合格的归档放进某个目录，返回路径 */
function makeArchive(dir: string, meta: AppMeta, name = `${meta.id}${PACKAGE_SUFFIX}`): string {
  mkdirSync(dir, { recursive: true })
  return writeArchive(join(dir, name), {
    [MANIFEST_NAME]: JSON.stringify(manifestOf(meta)),
    [DEFAULT_ENTRY]: '<!doctype html><html><body><div id="root"></div></body></html>',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'assets/index.js': 'export default 1\n'
  })
}

/** 造一个清单不合格的归档 */
function makeBadArchive(dir: string, meta: AppMeta, patch: Record<string, unknown>): string {
  mkdirSync(dir, { recursive: true })
  return writeArchive(join(dir, `${meta.id}${PACKAGE_SUFFIX}`), {
    [MANIFEST_NAME]: JSON.stringify({ ...manifestOf(meta), ...patch }),
    [DEFAULT_ENTRY]: '<!doctype html>',
    'icon.svg': '<svg/>'
  })
}

beforeEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
  for (const dir of [installedRoot, userData, source]) mkdirSync(dir, { recursive: true })
  process.env.LOCALAPPDATA = local
  // 上一轮 PK-024 为了摆出"两档根同 id"改过这两样；泄漏进下一条就是凭空多个包根
  electronApp.isPackaged = true
  delete process.env.AIRSHIP_APPS_ROOT
  scanInstalledPackages()
})

describe('把包拖进壳里装', () => {
  it('PK-015 合格的归档装进自装根，重扫后格子里就有它', () => {
    const file = makeArchive(source, life())
    expect(appIds()).not.toContain('life')

    const outcome = installPackage(file, false)

    expect(outcome).toEqual({ id: 'life', name: '生命游戏', replaced: false })
    const landed = join(installedRoot, `life${PACKAGE_SUFFIX}`)
    expect(statSync(landed).isFile(), '落点是自装根里的一个归档文件').toBe(true)
    expect(appIds(), '装完自己重扫过，不用重启').toContain('life')
    // 装 ≠ 运行：落点目录里只有那一个归档，没有任何"顺手打开"的痕迹
    expect(readdirSync(installedRoot)).toEqual([`life${PACKAGE_SUFFIX}`])
  })

  it('PK-016 不合格的归档装不上，自装根里一个字节都不留', () => {
    const bad = makeBadArchive(source, life(), { id: 'other' })

    expect(() => installPackage(bad, false)).toThrow(/这个包装不上/)
    expect(() => installPackage(bad, false)).toThrow(/与目录名 "life" 不一致/)
    expect(readdirSync(installedRoot), '不合格的不能留下任何痕迹').toEqual([])
    expect(appIds()).not.toContain('life')
  })

  it('PK-017 同 id 已在自装根里：不确认就不动原有的那一份', () => {
    installPackage(makeArchive(join(source, 'first'), life()), false)
    const landed = join(installedRoot, `life${PACKAGE_SUFFIX}`)
    const before = readFileSync(landed)

    // 又拖来一个同 id 的（内容不同：换个图标字节）
    const second = writeArchive(join(source, `life${PACKAGE_SUFFIX}`), {
      [MANIFEST_NAME]: JSON.stringify({ ...manifestOf(life()), sdkVersion: '1.3.0' }),
      [DEFAULT_ENTRY]: '<!doctype html><html><body><div id="root"></div></body></html>',
      'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><!-- 换了内容 --></svg>',
      'assets/index.js': 'export default 2\n'
    })

    const proposal = inspectPackage(second)
    expect(proposal.replacing, '自装根里已有同 id，提案里必须给出 replacing').not.toBeNull()
    expect(proposal.replacing!.meta.sdkVersion, '提案给的是磁盘上那份的清单').toBe('0.0.0-test')

    expect(() => installPackage(second, false)).toThrow(
      /这台机器上已经装了 生命游戏（0.0.0-test），要换成 1.3.0 吗？/
    )
    expect(readFileSync(landed), '没确认就一个字节都不许动').toEqual(before)

    const outcome = installPackage(second, true)
    expect(outcome.replaced, '确认之后才算覆盖').toBe(true)
    expect(readFileSync(landed)).not.toEqual(before)
    expect(readdirSync(installedRoot), '覆盖后不留 .prev- 备份').toEqual([`life${PACKAGE_SUFFIX}`])
  })

  it('PK-018 文件夹与别的扩展名都不装，也不猜', () => {
    const dir = join(source, 'life.airship')
    mkdirSync(dir, { recursive: true })
    expect(() => inspectPackage(dir)).toThrow(/这不是 airship 包：life.airship/)
    expect(() => inspectPackage(dir)).toThrow(/文件夹与别的扩展名都不装/)

    const zip = join(source, 'life.zip')
    writeFileSync(zip, '不是 airship 包', 'utf8')
    expect(() => inspectPackage(zip)).toThrow(/这不是 airship 包：life.zip/)

    expect(() => inspectPackage(join(source, 'moved-away.airship'))).toThrow(/读不到这个包/)
    expect(readdirSync(installedRoot), '被拒的那些都不该在自装根里留东西').toEqual([])
  })

  it('PK-019 装完那一行念得出它要了什么能力', () => {
    // 措辞的唯一真源在 @airship/contract：空清单念"不碰你的文件"，不是一句空话
    expect(capabilitiesPhrase([])).toBe('不碰你的文件')
    expect(capabilitiesPhrase(['fs.read', 'proc'])).toBe('读你的文件、跑外部程序')

    const proposal = inspectPackage(makeArchive(source, vcp()))
    expect(proposal.meta.capabilities.length, 'vcp 声明过能力').toBeGreaterThan(0)
    expect(capabilitiesPhrase(proposal.meta.capabilities)).toContain('读你的文件')
    expect(capabilitiesPhrase(proposal.meta.capabilities)).toContain('跑外部程序')
  })
})

describe('把装进壳的包卸掉', () => {
  it('PK-021 卸掉生效那一份归档，重扫后查不到这个 id，其余包一个字没动', () => {
    installPackage(makeArchive(source, life()), false)
    installPackage(makeArchive(source, vcp()), false)
    const landed = join(installedRoot, `life${PACKAGE_SUFFIX}`)
    const vcpLanded = join(installedRoot, `vcp${PACKAGE_SUFFIX}`)
    const vcpBefore = readFileSync(vcpLanded)

    const outcome = uninstallPackage('life', { purgeData: false, windowIsOpen: false })

    expect(outcome).toEqual({
      id: 'life',
      name: '生命游戏',
      origin: 'installed',
      dataRemoved: false,
      dataWasAbsent: false,
      tookOverByOtherRoot: false
    })
    expect(existsSync(landed), '那一份归档从磁盘上没了').toBe(false)
    expect(packageFor('life'), '重扫过：按 id 查不到包').toBeNull()
    expect(appIds()).not.toContain('life')
    expect(appIds(), '别的包不受影响').toContain('vcp')
    expect(readFileSync(vcpLanded)).toEqual(vcpBefore)
  })

  it('PK-022 窗口开着就不动磁盘，念得出为什么', () => {
    installPackage(makeArchive(source, life()), false)
    const landed = join(installedRoot, `life${PACKAGE_SUFFIX}`)
    const before = readFileSync(landed)
    mkdirSync(join(appBaseDir('life'), 'data'), { recursive: true })
    writeFileSync(join(appBaseDir('life'), 'settings.json'), '{}', 'utf8')

    expect(() => uninstallPackage('life', { purgeData: true, windowIsOpen: true })).toThrow(
      windowBlocksUninstall('生命游戏')
    )

    expect(readFileSync(landed), '被拒就一条字节都不许动').toEqual(before)
    expect(existsSync(join(appBaseDir('life'), 'settings.json')), '选了删数据也不许动').toBe(true)
    expect(packageFor('life')).not.toBeNull()
    expect(appIds()).toContain('life')
  })

  it('PK-023 连数据一起卸时那一族整没了，只卸载时原样留着', () => {
    installPackage(makeArchive(source, life()), false)
    installPackage(makeArchive(source, vcp()), false)
    for (const id of ['life', 'vcp']) {
      mkdirSync(join(appBaseDir(id), 'data'), { recursive: true })
      writeFileSync(join(appBaseDir(id), 'settings.json'), '{}', 'utf8')
    }

    const keep = uninstallPackage('life', { purgeData: false, windowIsOpen: false })
    expect(keep.dataRemoved, '只卸载不碰数据那一族').toBe(false)
    expect(existsSync(join(appBaseDir('life'), 'settings.json'))).toBe(true)
    expect(existsSync(join(appBaseDir('life'), 'data'))).toBe(true)

    installPackage(makeArchive(source, life()), false)
    expect(packageFor('life'), '重装回来还接着用那份数据').not.toBeNull()

    const purge = uninstallPackage('vcp', { purgeData: true, windowIsOpen: false })
    expect(purge.dataRemoved).toBe(true)
    expect(existsSync(appBaseDir('vcp')), 'data、cache、settings.json 整族没了').toBe(false)
    expect(existsSync(join(appBaseDir('life'), 'settings.json')), '别的应用那一族一个字没动').toBe(true)

    // 没开过窗口的应用本来就没有那一族：不许把"没得删"念成"删了"
    installPackage(makeArchive(source, vcp()), false)
    const none = uninstallPackage('vcp', { purgeData: true, windowIsOpen: false })
    expect(none.dataRemoved, '本来就不存在时不算删过').toBe(false)
    expect(none.dataWasAbsent).toBe(true)
  })

  it('PK-024 两档根同 id：卸掉生效那一份，被遮住的那一份顶上', () => {
    installPackage(makeArchive(source, life()), false)
    const landed = join(installedRoot, `life${PACKAGE_SUFFIX}`)
    const before = readFileSync(landed)
    const devRoot = join(sandbox, 'dev-apps')
    const devArchive = makeArchive(devRoot, life())

    electronApp.isPackaged = false
    process.env.AIRSHIP_APPS_ROOT = devRoot
    try {
      scanInstalledPackages()
      expect(packageFor('life')!.archive, '生效的是先扫到的那一档根里那份').toBe(devArchive)

      const outcome = uninstallPackage('life', { purgeData: false, windowIsOpen: false })

      expect(existsSync(devArchive), '删的是生效那一份').toBe(false)
      expect(readFileSync(landed), '被遮住那一份一个字节没变').toEqual(before)
      expect(outcome.origin, '回执说的是删掉那一份来自哪一档根').toBe('dev')
      expect(outcome.tookOverByOtherRoot, '自装根那份随之顶上').toBe(true)
      expect(packageFor('life')!.archive).toBe(landed)
      expect(appIds()).toContain('life')
    } finally {
      electronApp.isPackaged = true
      delete process.env.AIRSHIP_APPS_ROOT
      scanInstalledPackages()
    }
  })

  it('PK-025 卸掉之后它的地址读不出来，攒下的路径授权也作废', () => {
    installPackage(makeArchive(source, life()), false)
    grants.grantRead('life', join(source, 'notes.txt'))
    expect(grants.stats('life').read).toBe(1)

    uninstallPackage('life', { purgeData: false, windowIsOpen: false })

    const look = (id: string) => {
      const pkg = packageFor(id)
      return pkg ? { archive: pkg.archive, entry: entryOf(pkg.manifest) } : null
    }
    expect(resolvePackageEntry(`airship://life/${DEFAULT_ENTRY}`, look)).toEqual({ reason: notRegistered('life') })
    expect(grants.stats('life').read, '重装回来的同 id 认不得上一次拖进来的那些路径').toBe(0)
  })
})
