import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Capability } from '@airship/contract'

/**
 * BE-001 ~ BE-013：应用自带后台程序的通道与生命周期。
 *
 * 与 bridge.test.ts 同一套路：跑**真的 ipc.ts 与真的后端宿主**，只把两端换掉——
 * electron 的 `utilityProcess.fork` 换成一个可编程的假进程（桥的形状照 d.ts：
 * 父侧 `on('message', payload)` 收裸消息、`postMessage`/`kill`/`stdout`/`stderr`，别的一个方法不多），
 * 窗口归属照旧用替身台账。假进程默认"报就绪 + 回声"，个别方法的行为按名字改写：
 * `fail` 回失败句、`hang` 永不回话——被测代码感知不到对面是假的。
 *
 * 崩溃隔离本身（真进程 abort 不拖垮主进程）是实测记进架构文档的那一档，
 * 这里钉的是"进程没了之后调用听到哪句、之后还能不能再来"。
 */

const ipc = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

const shellState = vi.hoisted(() => ({
  owners: new Map<number, string>(),
  sent: [] as Array<{ owner: string; event: unknown }>
}))

const fake = vi.hoisted(() => ({
  children: [] as Array<FakeBackendChild>,
  autoReady: true,
  nextPid: 9100
}))

/** 后端进程在父侧的替身：只实现 utilityProcess 真有的那几样 */
class FakeBackendChild extends EventEmitter {
  killed = false
  readonly stdout = null
  readonly stderr = null
  readonly pid: number
  received: unknown[] = []
  /** "后端逻辑"：每条父→子消息怎么处理，用例可按需改写 */
  handle: (msg: { seq?: number; method?: string; payload?: unknown }) => void

  constructor(
    readonly file: string,
    readonly args: unknown[],
    readonly options: { env?: Record<string, string> }
  ) {
    super()
    this.pid = fake.nextPid++
    this.handle = (m) => {
      if (typeof m.seq !== 'number') return
      if (m.method === 'hang') return
      if (m.method === 'fail') {
        this.send({ seq: m.seq, ok: false, error: '没有这条待办' })
        return
      }
      this.send({ seq: m.seq, ok: true, value: m.payload })
    }
  }

  postMessage(message: unknown): void {
    this.received.push(message)
    this.handle(message as never)
  }

  kill(): boolean {
    this.killed = true
    // 真进程被杀之后会补一条 exit：假的要是不补，宿主里等收尾的链条就永远不落
    queueMicrotask(() => this.die(null))
    return true
  }

  /** 子 → 父的一条消息（父侧收到的就是裸 payload，实测的形状） */
  send(message: unknown): void {
    this.emit('message', message)
  }

  private dead = false

  die(code: number | null): void {
    if (this.dead) return
    this.dead = true
    this.emit('exit', code)
  }
}

vi.mock('electron', async () => {
  const { join } = await import('node:path')
  const { mkdirSync, rmSync } = await import('node:fs')
  const root = join(__dirname, '.tmp', 'backend-userData')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    ipcMain: { handle: (channel: string, fn: unknown) => ipc.set(channel, fn as never), on: () => undefined },
    BrowserWindow: Object.assign(class {}, { fromWebContents: () => null }),
    clipboard: { writeText: () => undefined, readText: () => '' },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    Notification: class {
      static isSupported(): boolean {
        return false
      }
      show(): void {}
    },
    shell: { openExternal: async () => undefined },
    Menu: { buildFromTemplate: (t: unknown) => t },
    Tray: class {
      on(): void {}
      destroy(): void {}
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }), createEmpty: () => ({ isEmpty: () => true }) },
    utilityProcess: {
      fork: (file: string, args: unknown[], options: { env?: Record<string, string> }) => {
        const child = new FakeBackendChild(file, args, options)
        fake.children.push(child)
        if (fake.autoReady) queueMicrotask(() => child.send({ ready: true }))
        return child
      }
    }
  }
})

vi.mock('../main/windows', () => ({
  ownerOfContents: (id: number) => shellState.owners.get(id) ?? null,
  bringAppToFront: () => undefined,
  sendTo: (owner: string, event: unknown) => {
    shellState.sent.push({ owner, event })
  }
}))

const { registerIpc } = await import('../main/ipc')
const { backendHost, setBackendEmitter, READY_TIMEOUT_SECONDS, INVOKE_TIMEOUT_SECONDS } = await import(
  '../main/services/backendHost'
)
const { registerPackageAt } = await import('../main/services/packageRegistry')
const { packageFixtureRoot, installPackageAt } = await import('./helpers/packages')
const { backendEntryMissing, backendExited, backendNoAnswer, backendNotReady, capDenied, identityMismatch, needString } =
  await import('@airship/contract')

registerIpc()
// 后端事件的路由接线与主进程 index.ts 同一份语义：emit 只贴归属标签，投哪扇窗由 windows 侧定
// （windows 已是替身，sendTo 落进同一本台账）
setBackendEmitter((owner, event) => shellState.sent.push({ owner, event }))

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

async function call<T>(channel: string, contentsId: number, ...args: unknown[]): Promise<Envelope<T>> {
  const fn = ipc.get(channel)
  if (!fn) throw new Error(`主进程没登记这条通道：${channel}`)
  return (await fn({ sender: { id: contentsId } }, ...args)) as Envelope<T>
}

function reason<T>(res: Envelope<T>): string {
  expect(res.ok).toBe(false)
  return (res as { error: string }).error
}

function lastChild(): FakeBackendChild {
  const child = fake.children[fake.children.length - 1]
  if (!child) throw new Error('没有起出任何后端进程')
  return child
}

/** 一个宏任务：fork 是同步的，就绪握手与消息投递只隔几个微任务，转一圈就都落地了 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const VCP = 101
const DAGOGO = 102
const TODO = 104
const DEMO = 105
const NOTE = 106

const base = { description: '带后端的示例应用', capabilities: ['backend'] as Capability[] }

// 两份额外夹具：todo / note 是"清单写了后端"的应用，demo 只声明能力不写入口
const root = packageFixtureRoot()
for (const [id, name] of [
  ['todo', '待办'],
  ['note', '便签']
] as const) {
  const { problems } = registerPackageAt(installPackageAt(root, { ...base, id, name, backend: 'backend/index.js' }))
  if (problems.length > 0) throw new Error(`后端夹具注册失败 ${id}：${problems.join('；')}`)
}
{
  const { problems } = registerPackageAt(installPackageAt(root, { ...base, id: 'demo', name: '只有能力没有入口' }))
  if (problems.length > 0) throw new Error(`后端夹具注册失败 demo：${problems.join('；')}`)
}

beforeEach(() => {
  shellState.owners.clear()
  shellState.owners.set(VCP, 'vcp')
  shellState.owners.set(DAGOGO, 'dagogo')
  shellState.owners.set(TODO, 'todo')
  shellState.owners.set(DEMO, 'demo')
  shellState.owners.set(NOTE, 'note')
  shellState.sent.length = 0
  fake.children.length = 0
  fake.autoReady = true
  backendHost.resetForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('后端通道过的是同样三道闸', () => {
  it('BE-001 没声明 backend 能力，调用被拒且点出能力名', async () => {
    expect(reason(await call('backend:invoke', DAGOGO, 'dagogo', 'echo'))).toBe(capDenied('dagogo', 'backend'))
  })

  it('BE-002 冒充别的应用名义调用被拒', async () => {
    expect(reason(await call('backend:invoke', VCP, 'todo', 'echo'))).toBe(identityMismatch('vcp', 'todo'))
  })

  it('BE-003 method 不合法时把收到的值原样念出来', async () => {
    expect(reason(await call('backend:invoke', TODO, 'todo', 0))).toBe(needString('method', 0))
    expect(fake.children.length, '参数不合法的调用不该起进程').toBe(0)
  })
})

describe('一次调用是一次请求-回话', () => {
  it('BE-004 办成了只把值交给应用，后端收到的与前端发出的一致', async () => {
    const res = await call<{ t: number }>('backend:invoke', TODO, 'todo', 'echo', { t: 1 })
    expect(res.ok ? res.value : res).toEqual({ t: 1 })
    const msg = lastChild().received[0] as { seq: number; method: string; payload: unknown }
    expect(msg.method).toBe('echo')
    expect(msg.payload).toEqual({ t: 1 })
    expect(typeof msg.seq).toBe('number')
  })

  it('BE-005 后端回的失败原样读得到，不被套第二层话', async () => {
    const p = call('backend:invoke', TODO, 'todo', 'fail')
    expect(reason(await p)).toBe('没有这条待办')
  })

  it('BE-006 声明了能力却没写后端入口，拒并点名缺哪个字段', async () => {
    expect(reason(await call('backend:invoke', DEMO, 'demo', 'echo'))).toBe(backendEntryMissing('demo'))
  })
})

describe('后端是自己的一份进程，拿到的目录只有它应用那一族', () => {
  it('BE-007 起后端时把三个位置原样交给它，入口在磁盘上摊平落好', async () => {
    await call('backend:invoke', TODO, 'todo', 'echo', 1)
    const child = lastChild()
    expect(child.options.env?.AIRSHIP_APP_ID).toBe('todo')
    expect(child.options.env?.AIRSHIP_DATA_DIR.replace(/\\/g, '/')).toMatch(/apps\/todo\/data$/)
    expect(child.options.env?.AIRSHIP_CACHE_DIR.replace(/\\/g, '/')).toMatch(/apps\/todo\/cache$/)
    expect(child.file.replace(/\\/g, '/')).toMatch(/apps\/todo\/backend\/index\.js$/)
    expect(existsSync(child.file), 'fork 吃的是落盘的真文件').toBe(true)
    expect(readFileSync(child.file, 'utf8'), '落的就是包里那份后端入口').toContain('ready')
  })

  it('BE-008 迟迟不报就绪，起动作废且进程不留', async () => {
    fake.autoReady = false
    vi.useFakeTimers()
    const p = call('backend:invoke', TODO, 'todo', 'echo')
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_SECONDS * 1000 + 50)
    expect(reason(await p)).toBe(backendNotReady('todo', READY_TIMEOUT_SECONDS))
    expect(lastChild().killed, '半起的摊子不能留').toBe(true)
  })
})

describe('生命周期跟着窗口走', () => {
  it('BE-009 后端中途退出，在途调用被拒并点名方法', async () => {
    const p = call('backend:invoke', TODO, 'todo', 'hang')
    await tick()
    const child = lastChild()
    expect(child.received.length, '这条调用已经交到后端手里').toBe(1)
    child.die(134)
    expect(reason(await p)).toBe(backendExited('hang'))
  })

  it('BE-010 退出之后再调用，会重新起一个并办成', async () => {
    const p = call('backend:invoke', TODO, 'todo', 'hang')
    await tick()
    const dead = lastChild()
    dead.die(134)
    expect(reason(await p)).toBe(backendExited('hang'))

    const again = await call('backend:invoke', TODO, 'todo', 'echo', 'second')
    expect(again.ok ? again.value : again).toBe('second')
    expect(fake.children.length, '用的是新进程').toBe(2)
    expect(lastChild()).not.toBe(dead)
  })

  it('BE-011 收掉一个应用的后端，别的应用的一条不碰', async () => {
    await call('backend:invoke', NOTE, 'note', 'echo', 1)
    const noteChild = lastChild()
    const hanging = call('backend:invoke', TODO, 'todo', 'hang')
    await tick()
    const todoChild = lastChild()
    expect(todoChild.received.length, '在途的那条已在 todo 的后端手里').toBe(1)

    backendHost.kill('todo')
    expect(reason(await hanging)).toBe(backendExited('hang'))
    expect(todoChild.killed).toBe(true)
    expect(noteChild.killed, 'note 的后端不归 todo 管').toBe(false)
    expect(backendHost.isRunning('note')).toBe(true)
    expect(backendHost.isRunning('todo')).toBe(false)
  })

  it('BE-012 一次调用超时不回，只拒这一条调用，进程留着', async () => {
    vi.useFakeTimers()
    const p = call('backend:invoke', TODO, 'todo', 'hang')
    await vi.advanceTimersByTimeAsync(INVOKE_TIMEOUT_SECONDS * 1000 + 50)
    expect(reason(await p)).toBe(backendNoAnswer('hang', INVOKE_TIMEOUT_SECONDS))
    const child = lastChild()
    expect(child.killed, '超时的只是这一条调用，进程没被收').toBe(false)

    vi.useRealTimers()
    const later = await call('backend:invoke', TODO, 'todo', 'echo', 'ok?')
    expect(later.ok ? later.value : later).toBe('ok?')
    expect(fake.children.length, '用的还是原来那个进程').toBe(1)
  })
})
describe('后端主动推的东西只回它自己那扇窗', () => {
  it('BE-013 后端推事件，事件按归属路由且不夹带别人的窗口', async () => {
    await call('backend:invoke', TODO, 'todo', 'echo', 1)
    lastChild().send({ event: true, method: 'changed', payload: { n: 1 } })
    expect(shellState.sent).toEqual([
      { owner: 'todo', event: { kind: 'backend:event', method: 'changed', payload: { n: 1 } } }
    ])
  })
})
