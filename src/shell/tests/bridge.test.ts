import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * BR-001 ~ BR-008：跨进程那一层调用的结果与措辞。
 *
 * 这里跑的是**真的 ipc.ts**：把 electron 的 ipcMain.handle 换成一个能取用 handler 的登记表，
 * 再用假 event.sender 冒充不同窗口去按真 id 调用。窗口管理本身（谁开了什么窗口）用替身顶掉，
 * 那是 `shell.md` 的事；这本册子只管"调用返回什么、被拒时念哪句"。
 */

const ipc = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

const io = vi.hoisted(() => ({ pick: [] as string[], save: '', clip: '', opened: '' }))

const shellState = vi.hoisted(() => ({
  owners: new Map<number, string>(),
  opened: [] as string[],
  broadcast: [] as unknown[],
  theme: null as { mode: string; resolved: string } | null,
  platform: 'macos' as string,
  front: 0
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

vi.mock('../main/windows', async () => {
  const { isKnownApp } = await import('../main/services/appRegistry')
  return {
    ownerOfContents: (id: number) => shellState.owners.get(id) ?? null,
    isRegistered: (id: string) => isKnownApp(id),
    openAppWindow: (id: string) => {
      shellState.opened.push(id)
    },
    openAppIds: () => shellState.opened,
    bringLauncherToFront: () => {
      shellState.front += 1
    },
    broadcast: (event: unknown) => shellState.broadcast.push(event),
    sendTo: (_owner: string, event: unknown) => shellState.broadcast.push(event),
    setCachedTheme: (t: { mode: string; resolved: string }) => {
      shellState.theme = t
    },
    themeSnapshotCache: () => shellState.theme,
    windowMetrics: () => [],
    currentPlatform: () => shellState.platform
  }
})

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
const LAUNCHER = 100

beforeEach(() => {
  shellState.owners.clear()
  shellState.owners.set(VCP, 'vcp')
  shellState.owners.set(DAGOGO, 'dagogo')
  shellState.owners.set(BOOKS, 'books')
  shellState.owners.set(LAUNCHER, 'shell')
  shellState.opened.length = 0
  shellState.broadcast.length = 0
})

/** 取错误原因：契约方法失败时应用 catch 到的就是这句 */
function reason<T>(res: Envelope<T>): string {
  expect(res.ok).toBe(false)
  return (res as { error: string }).error
}

describe('调用只返回信封，失败必须是中文句子', () => {
  it('BR-001 办成了只把值交给应用', async () => {
    const res = await call<{ data: string }>('shell:paths', VCP, 'vcp')
    expect(res.ok).toBe(true)
    const value = (res as { value: { data: string; cache: string; platform: string } }).value
    expect(value.data.replace(/\\/g, '/')).toMatch(/apps\/vcp\/data$/)
    expect(value.cache.replace(/\\/g, '/')).toMatch(/apps\/vcp\/cache$/)
  })

  it('BR-002 被拒时应用拿到的是中文原因，不是 Electron 的内部措辞', async () => {
    const res = await call('settings:set', DAGOGO, 'dagogo', 'prefs', { a: 1 })
    expect(res.ok).toBe(true)

    const bad = await call('settings:set', DAGOGO, 'dagogo', '', 1)
    const why = reason(bad)
    expect(why).toContain('必须是非空字符串')
    expect(why).not.toContain('Error invoking remote method')
  })

  it('BR-008 参数不合法时把收到的值原样念出来', async () => {
    const why = reason(await call('fs:read', VCP, 'vcp', 0))
    expect(why).toBe('path 必须是非空字符串，收到 0')
  })
})

describe('身份由壳注入，冒充不了别人', () => {
  it('BR-003 以别的应用名义调用被拒，原因点出归属', async () => {
    const why = reason(await call('fs:read', VCP, 'pdf', '/etc/passwd'))
    expect(why).toBe('身份不匹配：这个窗口属于 vcp，不能以 pdf 的名义调用')
  })

  it('BR-004 没登记过的来源一律拒', async () => {
    expect(reason(await call('fs:read', 4242, 'vcp', '/x'))).toBe('调用来源不是壳注册的窗口，拒绝')
  })

  it('BR-005 两套面各走各的', async () => {
    // 应用调启动器专用接口
    expect(reason(await call('launcher:openApp', VCP, 'vcp'))).toBe('这个接口只有启动器能用')
    // 启动器调应用专用接口
    expect(reason(await call('fs:read', LAUNCHER, 'vcp', '/x'))).toBe('这个接口只给应用用，启动器不该调')
    // 应用读写壳级设置
    expect(reason(await call('settings:get', VCP, 'shell', 'theme', null))).toBe('只有启动器能读写壳级设置')
  })
})

describe('未声明的能力一律拒绝', () => {
  it('BR-006 没声明的能力，原因点出能力名与清单路径', async () => {
    const why = reason(await call('clipboard:writeText', DAGOGO, 'dagogo', '你好'))
    expect(why).toBe('dagogo 没有声明 clipboard 能力（要用它就在 apps/dagogo/app.ts 的 capabilities 里声明）')
  })

  it('BR-007 共享命名空间没声明就用不了', async () => {
    const why = reason(await call('fs:resolveInShared', VCP, 'vcp', 'library', ['library.json']))
    expect(why).toBe('vcp 没有声明共享命名空间 library（在 apps/vcp/app.ts 的 sharedNamespaces 里声明）')

    // 声明了的应用走同一条路就给的出路径
    const ok = await call<string>('fs:resolveInShared', BOOKS, 'books', 'library', ['library.json'])
    expect(ok.ok ? ok.value.replace(/\\/g, '/') : ok).toMatch(/shared\/library\/library\.json$/)
  })

  it('BR-006b 工具既要有 proc 能力，也要在清单里声明过', async () => {
    // 没 proc 能力的应用问工具：先被能力闸拦住
    expect(reason(await call('tools:path', DAGOGO, 'dagogo', 'ffmpeg'))).toBe(
      'dagogo 没有声明 proc 能力（要用它就在 apps/dagogo/app.ts 的 capabilities 里声明）'
    )
    // 有 proc 但清单里没声明这个工具
    expect(reason(await call('tools:path', VCP, 'vcp', 'wslc'))).toBe(
      'vcp 没有声明 wslc 工具（要用它就在 apps/vcp/app.ts 的 tools 里声明）'
    )
    // 壳的工具表里根本没有这个名字
    expect(reason(await call('tools:path', VCP, 'vcp', 'nope'))).toContain('壳不认识的工具：nope')
  })
})

describe('对话框给出去的许可', () => {
  const dir = join(__dirname, '.tmp', 'picked')
  const one = join(dir, 'a.mp4')
  const other = join(dir, 'b.mp4')

  it('GR-005 选中的文件才读得到，它所在目录仍然不给', async () => {
    io.pick = [one]
    expect((await call('dialog:openFiles', VCP, 'vcp', {})).ok).toBe(true)

    expect(await call('fs:stat', VCP, 'vcp', one)).toMatchObject({ ok: true })
    expect(reason(await call('fs:stat', VCP, 'vcp', other))).toContain('没有读取权限')
    expect(reason(await call('fs:list', VCP, 'vcp', dir))).toContain('没有读取权限')
  })

  it('GR-007 要父目录授权的应用，得显式带 grantParentDir', async () => {
    mkdirSync(dir, { recursive: true })
    io.pick = [join(dir, 'c.mkv')]
    await call('dialog:openFiles', VCP, 'vcp', { grantParentDir: true })
    expect((await call('fs:list', VCP, 'vcp', dir)).ok).toBe(true)
  })

  it('GR-008 另存为只开放那一个写入目标，但同目录可读好回看产物', async () => {
    io.save = join(dir, 'out.mkv')
    expect((await call('dialog:saveFile', VCP, 'vcp', {})).ok).toBe(true)

    expect((await call('fs:ensureDir', VCP, 'vcp', join(dir, 'nope'))).ok).toBe(false)
    expect((await call('fs:stat', VCP, 'vcp', join(dir, 'other.mkv'))).ok).toBe(true)

    const write = await call('fs:write', VCP, 'vcp', join(dir, 'other.mkv'), 'x')
    expect(reason(write)).toContain('没有写入权限')
  })
})

describe('启动器面', () => {
  it('启动器能列应用、开应用，非 http 链接不开', async () => {
    expect((await call('launcher:openApp', LAUNCHER, 'vcp')).ok).toBe(true)
    expect(shellState.opened).toEqual(['vcp'])

    expect(reason(await call('launcher:openApp', LAUNCHER, 'ghost'))).toBe('没有注册这个应用：ghost')
    expect(reason(await call('launcher:openExternal', LAUNCHER, 'file:///C:/x'))).toContain('只允许打开 http/https 链接')
  })

  it('PK-026 卸载只认 id：这条通道只有启动器能用，没装过的 id 念没有注册', async () => {
    // 应用窗口那侧调不到（它连"往这台机器上删东西"的权力都没有）
    expect(reason(await call('launcher:uninstallPackage', VCP, 'vcp', false))).toBe('这个接口只有启动器能用')
    // 注册表里没有的 id：磁盘上什么都不必删
    expect(reason(await call('launcher:uninstallPackage', LAUNCHER, 'ghost', false))).toBe('没有注册这个应用：ghost')
    // 参数不合法念出收到的值
    expect(reason(await call('launcher:uninstallPackage', LAUNCHER, 'vcp', 'yes'))).toContain('purgeData 必须是 true 或 false')
  })

  it('PK-022 那条拒在通道上同样成立：台账说开着就不动磁盘', async () => {
    expect((await call('launcher:openApp', LAUNCHER, 'vcp')).ok).toBe(true)
    expect(reason(await call('launcher:uninstallPackage', LAUNCHER, 'vcp', true))).toContain(
      '的窗口还开着，先把它关掉再卸载'
    )
    expect((await call('launcher:apps', LAUNCHER)).ok, '格子里还有它').toBe(true)
  })
})
