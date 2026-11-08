// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { PACKAGE_ROOT_LABEL, windowBlocksUninstall, type InstalledApp, type PlatformId, type ShellInfoView, type UninstallResultView } from '@airship/contract'
import { Launcher } from '../Launcher'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi } from '@airship/sdk/testing'

/**
 * SH-025 ~ SH-029：格子上那颗管理键与卸载卡片念什么。
 *
 * 卸载的真判据（删掉哪一份、什么时候一条字节都不动）在 `packageInstall.test.ts`，
 * 这里只钉"用户看得见哪句话、点下去发出的是什么请求"——所以替身给的是回执，磁盘一概不碰。
 * 与装包那半边（`launcherInstall.test.tsx`）分工一样。
 */

const lifeApp: InstalledApp = {
  meta: { id: 'life', name: '生命游戏', description: '康威生命游戏', capabilities: [] },
  iconUrl: 'airship://life/icon.svg',
  origin: 'installed'
}

const vcpApp: InstalledApp = {
  meta: { id: 'vcp', name: 'vcp', description: '容器台', capabilities: ['proc'] },
  iconUrl: 'airship://vcp/icon.svg',
  origin: 'dev'
}

const MANAGE = '[data-test="卸载管理"]'

function outcome(over: Partial<UninstallResultView> = {}): UninstallResultView {
  return {
    id: 'life',
    name: '生命游戏',
    origin: 'installed',
    dataRemoved: false,
    dataWasAbsent: false,
    tookOverByOtherRoot: false,
    ...over
  }
}

const SETTINGS_INFO: ShellInfoView = { shellVersion: '0.0.0-test', roots: [{ origin: 'installed', dir: 'X:\\apps' }] }

describe('格子上的卸载', () => {
  it('SH-025 顶栏那颗管理键两态都念得出自己干什么，格子数量与名字不变', async () => {
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: { apps: async () => [lifeApp, vcpApp], currentPlatform: async () => 'windows' as PlatformId }
    })
    await m.settle()

    const key = () => m.container.querySelector(MANAGE) as HTMLButtonElement
    expect(key().title).toBe('卸载管理：点一下，每格露出卸载记号')
    expect(key().getAttribute('aria-pressed'), '没按下去就不是按着的那态').toBe('false')
    expect(m.container.querySelectorAll('.tile__mark').length).toBe(0)

    await m.pressIn(MANAGE)
    expect(m.container.querySelectorAll('.tile__mark').length, '两格都露出记号').toBe(2)
    expect(key().title).toBe('退出卸载管理：格子回到点开就开窗口')
    expect(key().getAttribute('aria-label')).toBe(key().title)
    expect(key().getAttribute('aria-pressed')).toBe('true')

    await m.pressIn(MANAGE)
    expect(m.container.querySelectorAll('.tile__mark').length).toBe(0)
    expect(m.container.querySelectorAll('.tile').length).toBe(2)
    expect(m.text()).toContain('生命游戏')
    expect(m.text()).toContain('vcp')
    m.unmount()
  })

  it('SH-026 管理态里点格子不开窗口，弹的是确认卡片；没点确认之前一条卸载请求都没发', async () => {
    let opened = 0
    let uninstalls = 0
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        apps: async () => [lifeApp],
        currentPlatform: async () => 'windows' as PlatformId,
        openApp: async () => {
          opened += 1
        },
        uninstallPackage: async () => {
          uninstalls += 1
          return outcome()
        }
      }
    })
    await m.settle()

    await m.pressIn(MANAGE)
    const tile = m.container.querySelector('.tile') as HTMLButtonElement
    expect(tile.getAttribute('aria-label')).toBe('卸载 生命游戏')

    await m.pressIn('.tile')
    expect(opened, '一格里同一时刻只有一个动作').toBe(0)
    expect(uninstalls, '卡片才是那一下确认，点格子不算').toBe(0)
    expect(m.text()).toContain('卸载 生命游戏？')
    expect(m.text()).toContain(`删掉的是${PACKAGE_ROOT_LABEL.installed}里那一份 life.airship 归档`)
    expect(m.has('只卸载')).toBe(true)
    expect(m.has('卸载并删数据')).toBe(true)
    expect(m.has('取消')).toBe(true)

    await m.press('取消')
    expect(m.text()).not.toContain('卸载 生命游戏？')
    expect(uninstalls).toBe(0)

    // 退出管理态，同一格发的才又是"打开"
    await m.pressIn(MANAGE)
    await m.pressIn('.tile')
    await m.settle()
    expect(opened, 'SH-002 那句"点一格开窗口"管的是一般态').toBe(1)
    m.unmount()
  })

  it('SH-027 卸载那一行念得出卸的是哪一档根、数据什么下落', async () => {
    let next = outcome()
    let calls = 0
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        apps: async () => [lifeApp],
        currentPlatform: async () => 'windows' as PlatformId,
        uninstallPackage: async () => {
          calls += 1
          return next
        }
      }
    })
    await m.settle()
    await m.pressIn(MANAGE)

    // 「只卸载」：数据留着
    next = outcome()
    await m.pressIn('.tile')
    await m.press('只卸载')
    expect(m.text()).toContain(`已卸载：生命游戏 · 来自${PACKAGE_ROOT_LABEL.installed} · 数据留着`)

    // 「卸载并删数据」：真删掉了那一族
    next = outcome({ dataRemoved: true })
    await m.pressIn('.tile')
    await m.press('卸载并删数据')
    expect(m.text()).toContain(`已卸载：生命游戏 · 来自${PACKAGE_ROOT_LABEL.installed} · 数据也删了`)

    // 本来就没有那一族：不许念成"数据也删了"，也不许念成"留着"
    next = outcome({ dataWasAbsent: true })
    await m.pressIn('.tile')
    await m.press('卸载并删数据')
    expect(m.text()).toContain(`已卸载：生命游戏 · 来自${PACKAGE_ROOT_LABEL.installed} · 本来就没有它的数据`)

    // 另一档根里还有同 id 那一份：这句话必须念出来，不然人以为自己卸掉了
    next = outcome({ origin: 'dev', tookOverByOtherRoot: true })
    await m.pressIn('.tile')
    await m.press('只卸载')
    expect(m.text()).toContain(`已卸载：生命游戏 · 来自${PACKAGE_ROOT_LABEL.dev} · 数据留着`)
    expect(m.text()).toContain('另一档根里还有一份，现在生效的是它')
    expect(calls).toBe(4)
    m.unmount()
  })

  it('SH-028 开着窗口点卸载，界面念主进程那一句，格子里还有它', async () => {
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        apps: async () => [lifeApp],
        currentPlatform: async () => 'windows' as PlatformId,
        uninstallPackage: async () => {
          throw new Error(windowBlocksUninstall('生命游戏'))
        }
      }
    })
    await m.settle()

    await m.pressIn(MANAGE)
    await m.pressIn('.tile')
    await m.press('只卸载')

    expect(m.text()).toContain(windowBlocksUninstall('生命游戏'))
    expect(m.text()).not.toContain('已卸载')
    expect(m.container.querySelectorAll('.tile').length).toBe(1)
    m.unmount()
  })

  it('SH-029 管理态进设置再回来，格子回到普通态', async () => {
    let opened = 0
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        apps: async () => [lifeApp],
        currentPlatform: async () => 'windows' as PlatformId,
        shellInfo: async () => SETTINGS_INFO,
        openApp: async () => {
          opened += 1
        }
      }
    })
    await m.settle()

    await m.pressIn(MANAGE)
    expect(m.container.querySelectorAll('.tile__mark').length).toBe(1)

    await m.pressIn('[data-test="设置"]')
    expect(m.text()).toContain('版本')
    await m.pressIn('[data-test="返回应用格子"]')

    expect(m.container.querySelectorAll('.tile__mark').length, '回来的该是原来那些格').toBe(0)
    await m.pressIn('.tile')
    expect(opened).toBe(1)
    m.unmount()
  })
})
