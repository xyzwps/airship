// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { notAPackage, overwriteNeedsConfirm, type PackageProposalView } from '@airship/contract'
import { Launcher } from '../Launcher'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi } from '@airship/sdk/testing'
import type { InstalledApp, PlatformId } from '@airship/contract'

/**
 * PK-017 / PK-018 / PK-019 与 SH-021 的界面那一半：
 * 拖进来时说什么、要覆盖时问什么、装完了怎么交代。
 *
 * 装包的真判据（落到哪个文件、不留残留）在 `packageInstall.test.ts`，
 * 这里只钉"用户看得见哪句话"——所以替身给的是提案与回执，磁盘一概不碰。
 */

const lifeApp: InstalledApp = {
  meta: { id: 'life', name: '生命游戏', description: '康威生命游戏', capabilities: [] },
  iconUrl: 'airship://life/icon.svg',
  origin: 'installed'
}

function proposal(over: Partial<PackageProposalView> = {}): PackageProposalView {
  return {
    id: 'life',
    name: '生命游戏',
    sdkVersion: '1.3.0',
    bytes: 80 * 1024,
    capabilities: [],
    replacing: null,
    addedCapabilities: [],
    removedCapabilities: [],
    ...over
  }
}

const file = (name = 'life.airship'): File => new File(['zip bytes'], name, { type: 'application/zip' })

describe('拖进启动器的包', () => {
  it('SH-021 拖着文件还没松手，界面就给得出"松手就装"', async () => {
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: { apps: async () => [], currentPlatform: async () => 'windows' as PlatformId }
    })
    await m.settle()
    expect(m.text()).not.toContain('松手就装')

    await m.dragOver('.launcher__body')
    expect(m.text()).toContain('松手就装')
    expect(m.text()).toContain('<id>.airship')
    m.unmount()
  })

  it('PK-019 装上了就念得出名字与它要的能力，格子不用重启就出现', async () => {
    let apps = 0
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        // 第一问还没有任何应用；装完启动器重新问一次，格子里就该有它
        currentPlatform: async () => 'windows' as PlatformId,
        apps: async () => (++apps === 1 ? [] : [lifeApp]),
        inspectPackage: async () => proposal(),
        installPackage: async () => ({ id: 'life', name: '生命游戏', replaced: false })
      }
    })
    await m.settle()
    expect(m.container.querySelectorAll('.tile').length).toBe(0)

    await m.dropFiles('.launcher__body', [file()])

    expect(m.text()).toContain('已装：生命游戏 · 能力：不碰你的文件')
    expect(m.container.querySelectorAll('.tile').length, '不用重启，格子里就有它').toBe(1)
    m.unmount()
  })

  it('PK-019b 有能力的包要把能力念出来，不是一句空话', async () => {
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        currentPlatform: async () => 'windows' as PlatformId,
        apps: async () => [],
        inspectPackage: async () => proposal({ capabilities: ['fs.read', 'proc'] }),
        installPackage: async () => ({ id: 'life', name: '生命游戏', replaced: false })
      }
    })
    await m.settle()
    await m.dropFiles('.launcher__body', [file()])

    expect(m.text()).toContain('能力：读你的文件、跑外部程序')
    m.unmount()
  })

  it('PK-017 同 id 要覆盖时先问一句，取消就不动', async () => {
    let installed = 0
    const replacing = { name: '生命游戏', sdkVersion: '1.2.0', capabilities: ['fs.read' as const] }
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        currentPlatform: async () => 'windows' as PlatformId,
        apps: async () => [lifeApp],
        inspectPackage: async () =>
          proposal({ replacing, addedCapabilities: ['proc' as const], capabilities: ['fs.read', 'proc'] }),
        installPackage: async () => {
          installed += 1
          return { id: 'life', name: '生命游戏', replaced: true }
        }
      }
    })
    await m.settle()
    await m.dropFiles('.launcher__body', [file()])

    // 卡片念得出旧版本、新版本、能力差异，以及"数据不动、不会自动打开"
    expect(m.text()).toContain(overwriteNeedsConfirm('生命游戏', '1.2.0', '1.3.0'))
    expect(m.text()).toContain('比已装的多了：跑外部程序')
    expect(m.text()).toContain('数据目录不会动')
    expect(installed, '没确认之前一颗字节都不该动').toBe(0)

    await m.press('取消')
    expect(m.text()).toContain('没动：生命游戏')
    expect(installed).toBe(0)

    // 再来一次，这回点覆盖
    await m.dropFiles('.launcher__body', [file()])
    await m.press('覆盖')
    expect(installed, '确认之后才装').toBe(1)
    expect(m.text()).toContain('换掉了原有的版本')
    m.unmount()
  })

  it('PK-018 拖进来的不是归档，界面念出拒的那句', async () => {
    let installed = 0
    const m = await mountUi(<Launcher />, {
      fake: new FakeAirship({ id: 'launcher', capabilities: [] }),
      shell: {
        currentPlatform: async () => 'windows' as PlatformId,
        apps: async () => [],
        inspectPackage: async () => {
          throw new Error(notAPackage('life.zip'))
        },
        installPackage: async () => {
          installed += 1
          return { id: 'x', name: 'x', replaced: false }
        }
      }
    })
    await m.settle()
    await m.dropFiles('.launcher__body', [file('life.zip')])

    expect(m.text()).toContain('这不是 airship 包：life.zip')
    expect(m.text()).toContain('文件夹与别的扩展名都不装')
    expect(installed).toBe(0)
    m.unmount()
  })
})
