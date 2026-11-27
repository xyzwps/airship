// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { FakeAirship, mountUi } from '@airship/sdk/testing'
import ChangeMeApp from '../CHANGE_MEApp.tsx'
import { app } from '../app.ts'

/**
 * 用例的地基是 `@airship/sdk/testing` 那个假 runtime：内存卷、命令行记录、两份名单的闸都在它身上，
 * 措辞直接取 `@airship/contract` 的真源，所以越界时用户看见的那句中文
 * 在这里与在真 runtime 里是同一句。
 *
 * 标题必须以册子里的编号开头（`just casecov` 做双向差集）。
 */
describe('显示名的第一屏', () => {
  it('CHANGE_ME-001 打开应用，界面上读得到那一句话', async () => {
    const fake = new FakeAirship({ id: app.id })
    const m = await mountUi(<ChangeMeApp api={fake.api} />, { fake })
    await m.settle()

    expect(m.text()).toContain('显示名')
    expect(m.text()).not.toContain('Error invoking remote method')
    m.unmount()
  })
})
