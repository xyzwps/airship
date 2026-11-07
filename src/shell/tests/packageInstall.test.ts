import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ENTRY, MANIFEST_NAME, PACKAGE_SUFFIX, capabilitiesPhrase } from '@airship/contract'
import { packageFixtureRoot, writeArchive } from './helpers/packages'
import { REAL_APPS, manifestOf } from './helpers/realApps'
import type { AppMeta } from '@airship/contract'

/**
 * PK-015 ~ PK-019：把包拖进壳里装。
 *
 * 这里测的是拖放背后主进程干的事：装到哪、什么情况下不装、覆盖为什么要确认。
 * 界面上的句子（"松手就装"、确认卡片、装完那一行）在 `launcher.test.tsx` 里钉。
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

const { inspectPackage, installPackage } = await import('../main/services/packageInstall')
const { appIds, installedPackages, scanInstalledPackages } = await import('../main/services/appRegistry')

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
