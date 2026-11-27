import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BR-001 ~ BR-008：跨进程那一层调用的结果与措辞。
 *
 * 这里跑的是**真的 ipc.ts**：把 electron 的 ipcMain.handle 换成一个能取用 handler 的登记表，
 * 再用假 event.sender 冒充不同窗口去按真 id 调用。窗口管理本身（谁开了什么窗口）用替身顶掉，
 * 那是 `runtime.md` 的事；这本册子只管"调用返回什么、被拒时念哪句"。
 */

const ipc = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

const io = vi.hoisted(() => ({ pick: [] as string[], save: '', clip: '', opened: '' }))

const shellState = vi.hoisted(() => ({
  owners: new Map<number, string>()
}))

vi.mock('electron', async () => {
  const { join } = await import('node:path')
  const { mkdirSync, rmSync } = await import('node:fs')
  const root = join(__dirname, '.tmp', 'ipc-userData')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const store = io
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    ipcMain: { handle: (channel: string, fn: unknown) => ipc.set(channel, fn as never), on: () => undefined },
    BrowserWindow: Object.assign(class {}, { fromWebContents: () => null }),
    clipboard: {
      writeText: (t: string) => {
        store.clip = t
      },
      readText: () => store.clip
    },
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: store.pick }),
      showSaveDialog: async () => ({ canceled: false, filePath: store.save })
    },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
      show(): void {}
    },
    shell: {
      openExternal: async (url: string) => {
        store.opened = url
      }
    },
    Menu: { buildFromTemplate: (t: unknown) => t },
    Tray: class {
      on(): void {}
      setImage(): void {}
      setToolTip(): void {}
      setContextMenu(): void {}
      destroy(): void {}
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
      createFromDataURL: () => ({ isEmpty: () => true }),
      createEmpty: () => ({ isEmpty: () => true })
    },
    __store: store
  }
})

vi.mock('../main/windows', () => ({
  ownerOfContents: (id: number) => shellState.owners.get(id) ?? null,
  bringAppToFront: () => undefined,
  sendTo: () => undefined
}))

const electronMock = await import('electron')
const { registerIpc } = await import('../main/ipc')

registerIpc()

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

/** 以某个窗口的身份调一条通道 */
async function call<T>(channel: string, contentsId: number, ...args: unknown[]): Promise<Envelope<T>> {
  const fn = ipc.get(channel)
  if (!fn) throw new Error(`主进程没登记这条通道：${channel}`)
  return (await fn({ sender: { id: contentsId } }, ...args)) as Envelope<T>
}

const VCP = 101
const DAGOGO = 102
const BOOKS = 103

beforeEach(() => {
  shellState.owners.clear()
  shellState.owners.set(VCP, 'airship-ffmpeg')
  shellState.owners.set(DAGOGO, 'airship-dago')
  shellState.owners.set(BOOKS, 'airship-reader')
})

/** 取错误原因：契约方法失败时应用 catch 到的就是这句 */
function reason<T>(res: Envelope<T>): string {
  expect(res.ok).toBe(false)
  return (res as { error: string }).error
}

describe('调用只返回信封，失败必须是中文句子', () => {
  it('BR-001 办成了只把值交给应用', async () => {
    const res = await call<{ data: string }>('runtime:paths', VCP, 'airship-ffmpeg')
    expect(res.ok).toBe(true)
    const value = (res as { value: { data: string; cache: string; platform: string } }).value
    expect(value.data.replace(/\\/g, '/')).toMatch(/\.airship\/data\/airship-ffmpeg$/)
    expect(value.cache.replace(/\\/g, '/')).toMatch(/\.airship\/data\/airship-ffmpeg\/cache$/)
  })

  it('BR-002 被拒时应用拿到的是中文原因，不是 Electron 的内部措辞', async () => {
    const res = await call('settings:set', DAGOGO, 'airship-dago', 'prefs', { a: 1 })
    expect(res.ok).toBe(true)

    const bad = await call('settings:set', DAGOGO, 'airship-dago', '', 1)
    const why = reason(bad)
    expect(why).toContain('必须是非空字符串')
    expect(why).not.toContain('Error invoking remote method')
  })

  it('BR-008 参数不合法时把收到的值原样念出来', async () => {
    const why = reason(await call('fs:read', VCP, 'airship-ffmpeg', 0))
    expect(why).toBe('path 必须是非空字符串，收到 0')
  })
})

describe('身份由 runtime 注入，冒充不了别人', () => {
  it('BR-003 以别的应用名义调用被拒，原因点出归属', async () => {
    const why = reason(await call('fs:read', VCP, 'airship-s3', '/etc/passwd'))
    expect(why).toBe('身份不匹配：这个窗口属于 airship-ffmpeg，不能以 airship-s3 的名义调用')
  })

  it('BR-004 没登记过的来源一律拒', async () => {
    expect(reason(await call('fs:read', 4242, 'airship-ffmpeg', '/x'))).toBe('调用来源不是 runtime 注册的窗口，拒绝')
  })
})

describe('没声明过的名单一律拒绝', () => {
  it('BR-007 共享命名空间没声明就用不了', async () => {
    const why = reason(await call('fs:resolveInShared', VCP, 'airship-ffmpeg', 'library', ['library.json']))
    expect(why).toBe('airship-ffmpeg 没有声明共享命名空间 library（在 apps/airship-ffmpeg/app.ts 的 sharedNamespaces 里声明）')

    // 声明了的应用走同一条路就给的出路径
    const ok = await call<string>('fs:resolveInShared', BOOKS, 'airship-reader', 'library', ['library.json'])
    expect(ok.ok ? ok.value.replace(/\\/g, '/') : ok).toMatch(/shared\/library\/library\.json$/)

    // 同一份"名单闸"在 tools 那一条上的两句原话（真 ipc.ts 的措辞）
    expect(reason(await call('tools:path', VCP, 'airship-ffmpeg', 'wslc'))).toBe(
      'airship-ffmpeg 没有声明 wslc 工具（要用它就在 apps/airship-ffmpeg/app.ts 的 tools 里声明）'
    )
    expect(reason(await call('tools:path', VCP, 'airship-ffmpeg', 'nope'))).toContain('runtime 不认识的工具：nope')
  })
})

describe('对话框给出去的许可', () => {
  const dir = join(__dirname, '.tmp', 'picked')
  const one = join(dir, 'a.mp4')
  const other = join(dir, 'b.mp4')

  it('GR-005 选中的文件才读得到，它所在目录仍然不给', async () => {
    io.pick = [one]
    expect((await call('dialog:openFiles', VCP, 'airship-ffmpeg', {})).ok).toBe(true)

    expect(await call('fs:stat', VCP, 'airship-ffmpeg', one)).toMatchObject({ ok: true })
    expect(reason(await call('fs:stat', VCP, 'airship-ffmpeg', other))).toContain('没有读取权限')
    expect(reason(await call('fs:list', VCP, 'airship-ffmpeg', dir))).toContain('没有读取权限')
  })

  it('GR-007 要父目录授权的应用，得显式带 grantParentDir', async () => {
    mkdirSync(dir, { recursive: true })
    io.pick = [join(dir, 'c.mkv')]
    await call('dialog:openFiles', VCP, 'airship-ffmpeg', { grantParentDir: true })
    expect((await call('fs:list', VCP, 'airship-ffmpeg', dir)).ok).toBe(true)
  })

  it('GR-008 另存为只开放那一个写入目标，但同目录可读好回看产物', async () => {
    io.save = join(dir, 'out.mkv')
    expect((await call('dialog:saveFile', VCP, 'airship-ffmpeg', {})).ok).toBe(true)

    expect((await call('fs:ensureDir', VCP, 'airship-ffmpeg', join(dir, 'nope'))).ok).toBe(false)
    expect((await call('fs:stat', VCP, 'airship-ffmpeg', join(dir, 'other.mkv'))).ok).toBe(true)

    const write = await call('fs:write', VCP, 'airship-ffmpeg', join(dir, 'other.mkv'), 'x')
    expect(reason(write)).toContain('没有写入权限')
  })
})
