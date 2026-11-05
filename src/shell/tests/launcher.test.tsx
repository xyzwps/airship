// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { APP_ENTRIES, entriesAvailableOn } from '../../apps'
import { platformIssue, platformUnsupported } from '@shared/errors'
import { Launcher } from '../Launcher'
import { FakeAirship } from './helpers/fakeAirship'
import { mountUi, type Mount } from './helpers/mount'
import type { PlatformId } from '@shared/protocol'

/**
 * SH-001 ~ SH-004：启动器那一屏。
 *
 * 用的是**真的应用注册表**——启动器契约的判据是"格子里只有图标与名字"，
 * 拿假清单去验，验的就只是替身自己。
 */

function mountLauncher(platform: PlatformId | 'unknown' = 'windows', opened: string[] = [], failure?: string): Promise<Mount> {
  const fake = new FakeAirship({ id: 'launcher', capabilities: [] })
  return mountUi(<Launcher />, {
    fake,
    shell: {
      currentPlatform: async () => platform,
      openApp: async (id: string) => {
        if (failure) throw new Error(failure)
        opened.push(id)
      }
    }
  })
}

describe('启动器就是一张应用格子', () => {
  it('SH-001 格子里读得到图标与名字，读不到说明文字与能力名', async () => {
    const m = await mountLauncher()
    await m.settle()
    const visible = m.text()

    for (const { meta } of Object.values(APP_ENTRIES)) {
      expect(visible, `格子里该读得到「${meta.name}」`).toContain(meta.name)
      expect(visible, `格子里不该出现「${meta.id}」的说明文字`).not.toContain(meta.description)
    }
    // 能力标签一概不放
    for (const cap of ['fs.read', 'fs.write', 'proc', 'shared', 'clipboard']) {
      expect(visible).not.toContain(cap)
    }
    // 图标是每张格子里的一枚图片
    expect(m.container.querySelectorAll('.tile').length).toBe(Object.keys(APP_ENTRIES).length)
    expect(m.container.querySelectorAll('.tile img').length).toBe(Object.keys(APP_ENTRIES).length)
    m.unmount()
  })

  it('SH-002 点一格，只把这一个应用的 id 交给壳', async () => {
    const opened: string[] = []
    const m = await mountLauncher('windows', opened)
    await m.settle()

    const target = Object.values(APP_ENTRIES)[0]!
    await m.press(target.meta.name)

    expect(opened).toEqual([target.meta.id])
    m.unmount()
  })

  it('SH-003 平台用不了的应用不进格子，没声明平台的全平台都在', async () => {
    const declared = Object.values(APP_ENTRIES).filter((e) => (e.meta.platforms ?? []).length > 0)
    const all = Object.keys(APP_ENTRIES).length

    const onWindows = await mountLauncher('windows')
    await onWindows.settle()
    const onMacos = await mountLauncher('macos')
    await onMacos.settle()

    const tilesOnWindows = onWindows.container.querySelectorAll('.tile').length
    const tilesOnMacos = onMacos.container.querySelectorAll('.tile').length

    // 每个声明了平台的应用：平台对上才进格子
    for (const e of declared) {
      const onWindowsNames = onWindows.text()
      const onMacosNames = onMacos.text()
      const wantsWindows = (e.meta.platforms ?? []).includes('windows')
      const wantsMacos = (e.meta.platforms ?? []).includes('macos')
      if (wantsWindows) expect(onWindowsNames).toContain(e.meta.name)
      else expect(onWindowsNames).not.toContain(e.meta.name)
      if (wantsMacos) expect(onMacosNames).toContain(e.meta.name)
      else expect(onMacosNames).not.toContain(e.meta.name)
    }
    // 没写 platforms 的应用在任何平台都在格子里
    const undeclared = all - declared.length
    expect(tilesOnMacos).toBe(undeclared)
    onWindows.unmount()
    onMacos.unmount()
  })

  it('SH-004 硬开一个用不了的应用，读得到原因而不是 Electron 的内部措辞', async () => {
    // 那句原因由壳的两份真函数拼出来，措辞不在用例里重写一遍
    const refusal = platformUnsupported('容器台', platformIssue({ name: '容器台', platforms: ['windows'] }, 'macos')!)
    const m = await mountLauncher('macos', [], refusal)
    await m.settle()

    // 格子上看不见它（SH-003），所以这里模拟"绕过格子硬开"：壳按同一份规则拒掉
    const first = entriesAvailableOn('macos')[0]!
    await m.press(first.meta.name)

    const visible = m.text()
    expect(visible).toContain(refusal)
    expect(visible).toContain('在这台机器上用不了')
    expect(visible).toContain('它只在 windows 上可用，这台机器是 macos')
    expect(visible).not.toContain('Error invoking remote method')
    m.unmount()
  })
})
