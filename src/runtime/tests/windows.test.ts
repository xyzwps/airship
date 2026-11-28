import { describe, expect, it, vi } from 'vitest'

/**
 * SH-007 / SH-010 / SH-033：一个应用一个窗口的规矩。
 *
 * 台账（谁有活窗口、归属怎么解除）是抽出来的纯逻辑，这里直接对着它验；
 * 窗口尺寸与摆放对着真的 openAppWindow 验，见 appWindowCreate.test.ts。
 */

vi.mock('electron', async () => {
  const { join: p } = await import('node:path')
  const root = p(__dirname, '.tmp', 'shell-userData')
  const { rmSync: rm, mkdirSync: mk } = await import('node:fs')
  rm(root, { recursive: true, force: true })
  mk(root, { recursive: true })
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    BrowserWindow: class {},
    ipcMain: { handle: () => undefined, on: () => undefined },
    dialog: {},
    clipboard: {},
    shell: {},
    Notification: class {}
  }
})

const { WindowLedger, appUserModelIdFor } = await import('../main/services/windowLedger')
const { ownerOfContents } = await import('../main/windows')

describe('窗口台账：一个应用只有一个窗口', () => {
  it('SH-033 同一个应用再指一次，判的是"聚焦已有"而不是"再开一个"', () => {
    const ledger = new WindowLedger()
    expect(ledger.decision('airship-ffmpeg')).toBe('create')

    ledger.open('airship-ffmpeg', 11)
    ledger.open('airship-s3', 12)
    expect(ledger.decision('airship-ffmpeg')).toBe('focus')
    expect(ledger.openAppIds()).toEqual(['airship-ffmpeg', 'airship-s3'])

    // 别的窗口关不关，不影响这个判定
    ledger.close(12)
    expect(ledger.decision('airship-ffmpeg')).toBe('focus')

    ledger.close(11)
    expect(ledger.decision('airship-ffmpeg')).toBe('create')
    expect(ledger.openAppIds()).toEqual([])
  })

  it('SH-007 窗口关了归属就解除；应用没开过时判的是可以新开', () => {
    const ledger = new WindowLedger()
    ledger.open('airship-ffmpeg', 21)
    expect(ledger.ownerOf(21)).toBe('airship-ffmpeg')
    expect(ledger.close(21)).toBe('airship-ffmpeg')
    expect(ledger.ownerOf(21)).toBeNull()
    expect(ledger.live('airship-ffmpeg')).toBe(false)
    expect(ledger.decision('airship-ffmpeg')).toBe('create')
  })

  it('SH-007b 主进程查不到已销毁窗口的归属', () => {
    // 真窗口路径：windows.ts 的 ownerOfContents 走的就是台账，没登记过的 id 一律认不出
    expect(ownerOfContents(999_999)).toBeNull()
  })

  it('SH-010 任务栏身份一应用一个，每个都带应用 id 后缀', () => {
    expect(appUserModelIdFor('airship-ffmpeg')).toBe('dev.xyzwp.airship.airship-ffmpeg')
    expect(appUserModelIdFor('airship-s3')).toBe('dev.xyzwp.airship.airship-s3')
    expect(appUserModelIdFor('airship-ffmpeg')).not.toBe(appUserModelIdFor('airship-s3'))
    // runtime 自己没有窗口：不存在不带后缀的特殊身份，任何归属都拼后缀
    expect(appUserModelIdFor('runtime')).toBe('dev.xyzwp.airship.runtime')
  })

})
