import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SH-005 ~ SH-010：一个应用一个窗口的规矩。
 *
 * 台账（谁有活窗口、归属怎么解除）是抽出来的纯逻辑，这里直接对着它验；
 * "关窗要杀掉这个应用的子进程"用一条**真在跑的子进程**验——观察它真的退场，而不是读代码猜。
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
const { proc, setProcEmitter } = await import('../main/services/proc')
const { allowExecutable, resetToolDiscovery } = await import('../main/services/tools')
const { ownerOfContents } = await import('../main/windows')
const events: Array<{ app: string; event: unknown }> = []

describe('窗口台账：一个应用只有一个窗口', () => {
  it('SH-005 同一个应用再点一次，判的是"聚焦已有"而不是"再开一个"', () => {
    const ledger = new WindowLedger()
    expect(ledger.decision('vcp')).toBe('create')

    ledger.open('vcp', 11)
    ledger.open('pdf', 12)
    expect(ledger.decision('vcp')).toBe('focus')
    expect(ledger.openAppIds()).toEqual(['vcp', 'pdf'])

    // 别的窗口关不关，不影响这个判定
    ledger.close(12)
    expect(ledger.decision('vcp')).toBe('focus')

    ledger.close(11)
    expect(ledger.decision('vcp')).toBe('create')
    expect(ledger.openAppIds()).toEqual([])
  })

  it('SH-007 窗口关了归属就解除；应用没开过时判的是可以新开', () => {
    const ledger = new WindowLedger()
    ledger.open('vcp', 21)
    expect(ledger.ownerOf(21)).toBe('vcp')
    expect(ledger.close(21)).toBe('vcp')
    expect(ledger.ownerOf(21)).toBeNull()
    expect(ledger.live('vcp')).toBe(false)
    expect(ledger.decision('vcp')).toBe('create')
  })

  it('SH-007b 主进程查不到已销毁窗口的归属', () => {
    // 真窗口路径：windows.ts 的 ownerOfContents 走的就是台账，没登记过的 id 一律认不出
    expect(ownerOfContents(999_999)).toBeNull()
  })

  it('SH-010 任务栏身份一应用一个，启动器自己不带后缀', () => {
    expect(appUserModelIdFor('vcp')).toBe('dev.xyzwp.airship.vcp')
    expect(appUserModelIdFor('pdf')).toBe('dev.xyzwp.airship.pdf')
    expect(appUserModelIdFor('vcp')).not.toBe(appUserModelIdFor('pdf'))
    expect(appUserModelIdFor('shell')).toBe('dev.xyzwp.airship')
  })

})

describe('关掉应用窗口，它名下的子进程跟着收掉', () => {
  beforeEach(() => {
    resetToolDiscovery()
    events.length = 0
    setProcEmitter((app, event) => events.push({ app, event }))
  })

  it('SH-006 只杀这个应用的任务，别人的任务一条都不碰', async () => {
    // 把 node 自己登记进白名单，才有"真在跑的子进程"可观察
    allowExecutable(process.execPath)

    const sleeper = ['-e', 'setInterval(() => {}, 5000)']
    proc.start('vcp', { exe: process.execPath, args: sleeper, jobId: 'mine' })
    proc.start('pdf', { exe: process.execPath, args: sleeper, jobId: 'theirs' })

    await waitFor(() => proc.list('vcp').length === 1 && proc.list('pdf').length === 1)

    expect(proc.list('vcp')).toEqual(['mine'])

    const killed = proc.killApp('vcp')
    expect(killed).toBe(1)

    await waitFor(() => proc.list('vcp').length === 0)
    expect(proc.list('vcp')).toEqual([])
    // 别的应用名下的任务一条都不被碰
    expect(proc.list('pdf')).toEqual(['theirs'])

    const exits = events.filter((e) => (e.event as { kind?: string }).kind === 'proc:exit')
    expect(exits.length).toBe(1)
    expect(exits[0]!.app).toBe('vcp')
    expect((exits[0]!.event as { result: { signal: string | null } }).result.signal).toBe('SIGKILL')

    proc.killApp('pdf')
    await waitFor(() => proc.list('pdf').length === 0)
    proc.killAll()
  })
})

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('等超时了')
    await new Promise((r) => setTimeout(r, 20))
  }
}
