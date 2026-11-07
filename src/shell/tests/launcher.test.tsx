// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { notRegistered, platformIssue, platformUnsupported } from '@airship/contract'
import { scanPackages, type InstalledPackage } from '../main/services/packageRegistry'
import { packageFixtureRoot, writeFixturePackages } from './helpers/packages'
import { Launcher } from '../Launcher'
import { FakeAirship } from '@airship/sdk/testing'
import { mountUi, type Mount } from '@airship/sdk/testing'
import type { PlatformId } from '@airship/contract'

/**
 * SH-001 ~ SH-004、SH-014、SH-020：启动器那一屏。
 *
 * 用的是**运行期扫出来的那份包表**：把仓库里的真清单落成临时包根，再让壳自己扫一遍。
 * 启动器的判据是"格子里只有图标与名字"，拿手写假清单去验，验的就只是替身自己。
 *
 * 列表从主进程问来（`airshipShell.apps()`）——渲染侧自己扫目录、再与主进程对名单那条路
 * 已经拆掉了，现在只剩一份真源。
 */

const root = writeFixturePackages(packageFixtureRoot())
const PACKAGES = scanPackages([{ dir: root, origin: 'dev' }]).packages

function mountLauncher(
  platform: PlatformId | 'unknown' = 'windows',
  opened: string[] = [],
  failure?: string
): Promise<Mount> {
  const fake = new FakeAirship({ id: 'launcher', capabilities: [] })
  return mountUi(<Launcher />, {
    fake,
    shell: {
      apps: async () => PACKAGES.map((p) => ({ meta: p.meta, iconUrl: p.iconUrl })),
      currentPlatform: async () => platform,
      openApp: async (id: string) => {
        if (failure) throw new Error(failure)
        opened.push(id)
      }
    }
  })
}

/** 平台上用得了的那些——判据函数与启动器用同一个，不在用例里重写一遍规则 */
function availableOn(platform: PlatformId | 'unknown'): InstalledPackage[] {
  return PACKAGES.filter((p) => platformIssue(p.meta, platform) === null)
}

/** SH-004 的依据要来自真清单：找一个声明了平台、且这台 mac 用不了的应用 */
function blockedOnMacos(): InstalledPackage {
  const hit = PACKAGES.find((p) => (p.meta.platforms ?? []).length > 0 && platformIssue(p.meta, 'macos') !== null)
  if (!hit) throw new Error('没有任何应用声明了"在 macos 上用不了"，SH-004 这条判据就没了依据')
  return hit
}

describe('启动器就是一张应用格子', () => {
  it('SH-001 格子里读得到图标与名字，读不到说明文字与能力名', async () => {
    const m = await mountLauncher()
    await m.settle()
    const visible = m.text()

    for (const pkg of PACKAGES) {
      expect(visible, `格子里该读得到「${pkg.meta.name}」`).toContain(pkg.meta.name)
      expect(visible, `格子里不该出现「${pkg.meta.id}」的说明文字`).not.toContain(pkg.meta.description)
    }
    // 能力标签一概不放
    for (const cap of ['fs.read', 'fs.write', 'proc', 'shared', 'clipboard']) {
      expect(visible).not.toContain(cap)
    }
    // 图标是每张格子里的一枚图片，一格一枚
    const count = availableOn('windows').length
    expect(m.container.querySelectorAll('.tile').length).toBe(count)
    expect(m.container.querySelectorAll('.tile img').length, '每格都该有一枚图片').toBe(count)
    m.unmount()
  })

  it('SH-002 点一格，只把这一个应用的 id 交给壳', async () => {
    const opened: string[] = []
    const m = await mountLauncher('windows', opened)
    await m.settle()

    const target = availableOn('windows')[0]!
    await m.press(target.meta.name)

    expect(opened).toEqual([target.meta.id])
    m.unmount()
  })

  it('SH-003 平台用不了的应用不进格子，没声明平台的全平台都在', async () => {
    const declared = PACKAGES.filter((p) => (p.meta.platforms ?? []).length > 0)

    const onWindows = await mountLauncher('windows')
    await onWindows.settle()
    const onMacos = await mountLauncher('macos')
    await onMacos.settle()

    // 每个声明了平台的应用：平台对上才进格子
    for (const pkg of declared) {
      const wantsWindows = (pkg.meta.platforms ?? []).includes('windows')
      const wantsMacos = (pkg.meta.platforms ?? []).includes('macos')
      expect(onWindows.text().includes(pkg.meta.name), `${pkg.meta.id} 在 windows 上`).toBe(wantsWindows)
      expect(onMacos.text().includes(pkg.meta.name), `${pkg.meta.id} 在 macos 上`).toBe(wantsMacos)
    }
    // 没写 platforms 的应用在任何平台都在格子里
    expect(availableOn('macos').length).toBe(PACKAGES.length - declared.length)
    expect(onMacos.container.querySelectorAll('.tile').length).toBe(availableOn('macos').length)
    expect(onWindows.container.querySelectorAll('.tile').length).toBe(availableOn('windows').length)
    onWindows.unmount()
    onMacos.unmount()
  })

  it('SH-004 硬开一个用不了的应用，读得到原因而不是 Electron 的内部措辞', async () => {
    const blocked = blockedOnMacos()
    // 那句原因由壳的两份真函数拼出来，措辞不在用例里重写一遍
    const refusal = platformUnsupported(blocked.meta.name, platformIssue(blocked.meta, 'macos')!)
    const m = await mountLauncher('macos', [], refusal)
    await m.settle()

    // 格子上看不见它（SH-003），这里模拟"绕过格子硬开"：壳按同一份规则拒掉
    const first = availableOn('macos')[0]!
    await m.press(first.meta.name)

    const visible = m.text()
    expect(visible).toContain(refusal)
    expect(visible).toContain('在这台机器上用不了')
    expect(visible).toContain(blocked.meta.name)
    expect(visible).not.toContain('Error invoking remote method')
    m.unmount()
  })

  it('SH-014 硬开一个没装进壳的应用，界面念的是主进程那一句拒绝', async () => {
    // 包根里没有这个 id：主进程按 notRegistered 拒，渲染侧不许另写一套措辞
    const m = await mountLauncher('windows', [], notRegistered('ghost'))
    await m.settle()

    const first = availableOn('windows')[0]!
    await m.press(first.meta.name)

    expect(m.text()).toContain('没有注册这个应用：ghost')
    expect(m.text()).not.toContain('Error invoking remote method')
    m.unmount()
  })

  it('SH-020 一个应用都没装进来时读得到这一句，不是空着一屏', async () => {
    const empty = new FakeAirship({ id: 'launcher', capabilities: [] })
    const m = await mountUi(<Launcher />, {
      fake: empty,
      shell: { apps: async () => [], currentPlatform: async () => 'windows' as PlatformId }
    })
    await m.settle()
    const visible = m.text()
    expect(visible).toContain('这台机器上还没有装进壳的应用')
    expect(visible, '要说清开发时怎么把包产出来').toContain('just build-apps')
    expect(visible, '要说清运行时装的包放在哪儿').toContain('LOCALAPPDATA')
    expect(m.container.querySelectorAll('.tile').length).toBe(0)
    m.unmount()
  })
})
