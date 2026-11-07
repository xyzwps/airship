// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT_LABEL, type InstalledApp, type PlatformId, type ShellInfoView } from '@airship/contract'
import { Launcher } from '../Launcher'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi, type Mount } from '@airship/sdk/testing'

/**
 * SH-022 ~ SH-024：壳自己那一屏设置。
 *
 * 这一族的判据是"那一页念得出什么"，所以屏上那两行的**值来自替身报回来的那一份**：
 * 版本号用一个不可能是真版本的串，界面要是自己写了一份，用例立刻红。
 * 目录表同样由替身给：自装根总有一条，开发根给不给就是 SH-023 那一档的分界。
 *
 * 格子里的应用用三份手写的假清单就够——SH-024 钉的是"换完屏回来还是那几格"，
 * 与清单的形状无关（清单形状由 `launcher.test.tsx` 拿真包扫出来的那一份守着）。
 */

const APPS: InstalledApp[] = [
  { meta: { id: 'life', name: '生命游戏', description: '康威生命游戏', capabilities: [] }, iconUrl: null },
  { meta: { id: 'pdf', name: 'PDF', description: '看 PDF', capabilities: [] }, iconUrl: null },
  { meta: { id: 'vcp', name: 'vcp', description: '转码', capabilities: [] }, iconUrl: null }
]

/** 版本与包根都由这里给：界面读到的就是这一份，一个数字都不自己拼 */
function info(over: Partial<ShellInfoView> = {}): ShellInfoView {
  return {
    shellVersion: '9.9.9-用例',
    roots: [{ origin: 'installed', dir: 'C:\\ fake \\安装目录\\airship\\apps' }],
    ...over
  }
}

function mountSettings(shown: ShellInfoView): Promise<Mount> {
  return mountUi(<Launcher />, {
    fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
    shell: {
      apps: async () => APPS,
      currentPlatform: async () => 'windows' as PlatformId,
      shellInfo: async () => shown
    }
  })
}

/** 点右上角那颗设置键，进那一屏 */
async function enterSettings(m: Mount): Promise<void> {
  await m.pressIn('[data-test="设置"]')
}

describe('壳自己那一屏设置', () => {
  it('SH-022 进设置那一屏，读得到版本与应用装在哪个目录', async () => {
    const shown = info()
    const m = await mountSettings(shown)
    await m.settle()
    // 格子上读不到这些（壳状态不进格子，SH-001）
    expect(m.text()).not.toContain(shown.shellVersion)

    await enterSettings(m)

    expect(m.text()).toContain('设置')
    expect(m.text()).toContain('版本')
    expect(m.text(), '版本号是主进程报的那个，不是界面自己写的').toContain(shown.shellVersion)
    expect(m.text()).toContain(PACKAGE_ROOT_LABEL.installed)
    expect(m.text()).toContain(shown.roots[0]!.dir)
    m.unmount()
  })

  it('SH-023 开发包根只在那台机器上真有它时才多出一行', async () => {
    const shipped = info()
    const m1 = await mountSettings(shipped)
    await m1.settle()
    await enterSettings(m1)
    expect(m1.text(), '只有自装根时不该冒出开发包根那一行').not.toContain(PACKAGE_ROOT_LABEL.dev)
    expect(m1.text()).toContain(PACKAGE_ROOT_LABEL.installed)
    m1.unmount()

    const devDir = 'C:\\ fake \\开发根\\dist-apps'
    const developing = info({ roots: [{ origin: 'dev', dir: devDir }, ...shipped.roots] })
    const m2 = await mountSettings(developing)
    await m2.settle()
    await enterSettings(m2)
    expect(m2.text()).toContain(PACKAGE_ROOT_LABEL.dev)
    expect(m2.text()).toContain(devDir)
    // 两个根各念各的目录，不是一行里挤在一起
    const rows = m2.container.querySelectorAll('.settings__row')
    expect(rows.length, '版本 + 两个根').toBe(3)
    expect(rows[1]!.textContent).toContain(PACKAGE_ROOT_LABEL.dev)
    expect(rows[1]!.textContent).toContain(devDir)
    expect(rows[2]!.textContent).toContain(PACKAGE_ROOT_LABEL.installed)
    expect(rows[2]!.textContent).toContain(shipped.roots[0]!.dir)
    m2.unmount()
  })

  it('SH-024 从设置那一屏回格子，格子还是原来那些格', async () => {
    const m = await mountSettings(info())
    await m.settle()
    expect(m.container.querySelectorAll('.tile').length).toBe(APPS.length)

    await enterSettings(m)
    expect(m.container.querySelectorAll('.tile').length, '设置那一屏没有格子').toBe(0)
    expect(m.text()).toContain(PACKAGE_ROOT_LABEL.installed)

    await m.pressIn('[data-test="返回应用格子"]')
    expect(m.container.querySelectorAll('.tile').length).toBe(APPS.length)
    for (const app of APPS) expect(m.text()).toContain(app.meta.name)
    expect(m.text(), '回到格子后那一屏的话该收回去').not.toContain(PACKAGE_ROOT_LABEL.installed)
    m.unmount()
  })
})
