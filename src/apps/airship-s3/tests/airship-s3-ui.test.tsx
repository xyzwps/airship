// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeAirship, mountUi, type Mount } from '@airship/sdk/testing'
import S3App from '../s3App.tsx'
import { app } from '../app.ts'
import { CURRENT_KEY, SOURCES_KEY, type Source } from '../connection.ts'
import { handle as backendHandle, type BackendIo } from '../backendStore.ts'
import { FakeS3, type Content, type SeedObject } from './helpers/fakeS3.ts'

/**
 * OS 册子的影子：界面读得到哪句话、点下去变成什么。
 *
 * 2026-11-24 传输整族搬进随包后端之后，这里的地基是同一份 `backendStore.handle`
 * 接在 `FakeAirship` 的 backend 替身上——应用侧调的 `backend.invoke` 走的就是
 * 真业务代码，网络那一边仍是 `helpers/fakeS3.ts` 那个真起在 127.0.0.1 上的假端点
 * （签名、分段、XML 解析这一整条链原样跑过；换 `globalThis.fetch` 拦不到：
 * 测试里 SDK 挑的是 Node 那一档传输），盘那一边是替身的内存卷（`volumeIo`）。
 *
 * 浏览器里那条传输——也就是出包后那个窗口真正用的那一条——不在这里验，
 * 归 `just shot` 连真 RustFS：上传、列层、详情、中文预览都在那张截图里看得见。
 */

const MB = 1024 * 1024

interface OpenOptions {
  seed?: Record<string, Record<string, SeedObject>>
  files?: Record<string, Content>
  picks?: Array<string[] | string | null>
  /** 拖放名 → 本机路径的对照表，喂给 `fs.pathForFile`；表里没有的名字换出来是空串 */
  dropPaths?: Record<string, string>
  /** 后端按区间读本地字节前等多久——给"传输还在进行中"那族判据留出窗口 */
  ioDelay?: number
  /** 设置里已经存过连接（用这台假端点的地址）；不给就是"第一次打开" */
  stored?: boolean
  /** 那个源在列表里的名字 */
  name?: string
  confirm?: boolean
}

interface Opened {
  m: Mount
  fake: FakeAirship
  s3: FakeS3
  /** 假端点的地址，界面上顶栏念的就是它 */
  endpoint: string
  host: string
  /** 设置里那一个源（名字与密钥由 open 造出来） */
  source: Source
  /** 下载写完的字节数：落点路径 → 字节（大对象不真留字节，判数就判这里） */
  written: Map<string, number>
}

const stoppers: Array<() => Promise<void>> = []
const mounts: Mount[] = []

/**
 * 后端要碰盘的那几件事在内存卷上的形状：上传按路径从这里读，下载完成后写回它。
 * 超过 4 MB 的只数字节不存（演 300 MB 的下载不真分配那 300 MB，OS-064 判的是数）；
 * 断线撤单时落点清零——与真后端那份"半份文件都不留"同形（OS-063）。
 */
function volumeIo(fake: FakeAirship, written: Map<string, number>, ioDelay = 0): BackendIo {
  const bytesOf = (p: string): Uint8Array | null => {
    const hit = fake.vol.get(p)
    if (hit === undefined) return null
    return typeof hit === 'string' ? Buffer.from(hit, 'utf8') : hit
  }
  return {
    fileSize: async (p) => (p === '' ? null : (bytesOf(p)?.byteLength ?? null)),
    readRange: async (p, start, length) => {
      if (ioDelay > 0) await new Promise((r) => setTimeout(r, ioDelay))
      const b = bytesOf(p)
      if (b === null) throw new Error(`读不到文件：${p}`)
      return b.slice(start, start + Math.max(0, Math.min(length, b.byteLength - start)))
    },
    sink: (p) => {
      const parts: Uint8Array[] = []
      let total = 0
      return {
        append: async (chunk) => {
          parts.push(chunk)
          total += chunk.byteLength
        },
        finish: async () => {
          written.set(p, total)
          if (total <= 4 * MB) {
            const merged = new Uint8Array(total)
            let at = 0
            for (const x of parts) {
              merged.set(x, at)
              at += x.byteLength
            }
            fake.seed(p, merged)
          }
          return total
        },
        abort: async () => {
          written.delete(p)
          fake.vol.delete(p)
        }
      }
    }
  }
}

/** 替身 runtime 与真业务后端的接线：网络在假端点，盘在内存卷 */
function newFake(
  options: { files?: Record<string, Content>; picks?: Array<string[] | string | null>; dropPaths?: Record<string, string>; ioDelay?: number } = {}
): { fake: FakeAirship; written: Map<string, number> } {
  const written = new Map<string, number>()
  let io!: BackendIo
  const fake = new FakeAirship({
    id: app.id,
    files: options.files,
    picks: options.picks,
    dropPaths: options.dropPaths,
    backend: (method, payload, ctl) => backendHandle(method, payload, io, ctl.event)
  })
  io = volumeIo(fake, written, options.ioDelay ?? 0)
  return { fake, written }
}

async function open(options: OpenOptions = {}): Promise<Opened> {
  const s3 = new FakeS3(options.seed ?? { demo: {}, archive: {} })
  const endpoint = await s3.start()
  stoppers.push(() => s3.stop())
  const host = new URL(endpoint).host

  const { fake, written } = newFake({
    files: options.files,
    picks: options.picks,
    dropPaths: options.dropPaths,
    ioDelay: options.ioDelay
  })
  const source: Source = {
    name: options.name ?? '本机',
    endpoint,
    region: 'us-east-1',
    accessKeyId: 'rustfsadmin',
    secretAccessKey: 'rustfsadmin'
  }
  if (options.stored !== false) {
    fake.settingsStore[SOURCES_KEY] = [source]
    fake.settingsStore[CURRENT_KEY] = source.name
  }

  const m = await mountUi(<S3App api={fake.api} />, { fake, confirm: options.confirm })
  mounts.push(m)
  await quiet(m)
  return { m, fake, s3, endpoint, host, source, written }
}

/** 第一次打开：设置里一个源都没有，连接卡摊着 */
async function openFresh(options: Omit<OpenOptions, 'stored'> = {}): Promise<Opened> {
  return open({ ...options, stored: false })
}

afterEach(async () => {
  for (const m of mounts.splice(0)) m.unmount()
  for (const stop of stoppers.splice(0)) await stop()
  vi.unstubAllGlobals()
})

/**
 * 等到应用把话说完。
 *
 * 界面上任何"正在…"那句还在，就说明还有请求在路上；那句没了就走。
 * 定轮数等法要么慢得把用例拖到超时（超时后这条异步链还在跑，会搅乱下一条用例），
 * 要么短了盖不住一次真实的 发请求 → 收响应 → 解析 那条链。
 */
async function quiet(m: Mount): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    if (!m.text().includes('正在')) break
  }
  await m.settle(2)
}

/** 等到界面上出现那句话（大文件分段上传比一次列表慢得多，轮数等不出来） */
async function until(m: Mount, done: () => boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`等不到界面念完。当前读得到：${m.text().slice(0, 200)}`)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
  await quiet(m)
}

async function tap(m: Mount, selector: string): Promise<void> {
  await m.pressIn(selector)
  await quiet(m)
}

/** 那句话现在住在哪：可见文字，或某颗键的悬停说明与无障碍名称（图标化之后按后者找） */
function hasLabel(m: Mount, label: string): boolean {
  return m.has(label) || m.container.querySelector(`[title="${label}"], [aria-label="${label}"]`) !== null
}

async function tapText(m: Mount, label: string): Promise<void> {
  const el = m.container.querySelector<HTMLElement>(`button[title="${label}"], button[aria-label="${label}"]`)
  if (!el) {
    // 还写着字的键（源面板里那行「添加源」这一族）
    await m.press(label)
    await quiet(m)
    return
  }
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await quiet(m)
}

async function fill(m: Mount, where: string, value: string): Promise<void> {
  await m.type(where, value)
  await quiet(m)
}

/** 进一个桶并等列表画出来 */
async function enter(m: Mount, bucket: string): Promise<void> {
  await tap(m, `[data-test="bucket:${bucket}"]`)
}

/** 表里的对象行与目录行数目 */
function objectRows(m: Mount): number {
  return m.container.querySelectorAll('[data-test^="row:"]').length
}

function prefixRows(m: Mount): number {
  return m.container.querySelectorAll('[data-test^="dir:"]').length
}

/** 翻页那一族用的对象堆：600 把键超一段的 500，正好演"端点截了一段" */
function manyObjects(n: number): Record<string, SeedObject> {
  const out: Record<string, SeedObject> = {}
  for (let i = 1; i <= n; i += 1) out[`k${String(i).padStart(3, '0')}.txt`] = { body: 'x', type: 'text/plain' }
  return out
}

/** OS-060 那一层：n 个目录、每个 files 把键——假端点按真账数键，一段 500 键装不下几个目录 */
function dirLayer(n: number, files: number): Record<string, SeedObject> {
  const out: Record<string, SeedObject> = {}
  for (let i = 1; i <= n; i += 1) {
    const d = `d${String(i).padStart(3, '0')}/`
    for (let f = 0; f < files; f += 1) out[`${d}f${f}.txt`] = { body: 'x', type: 'text/plain' }
  }
  return out
}

function pageText(m: Mount): string {
  return m.field('page')?.textContent ?? ''
}

function disabledOf(m: Mount, test: string): boolean {
  return (m.field(test) as HTMLButtonElement | null)?.disabled !== false
}

/** 假端点上那个对象现在的文本内容（没有这个对象就是空串） */
function textOf(s3: FakeS3, bucket: string, key: string): string {
  const stored = s3.object(bucket, key)
  return stored === undefined ? '' : new TextDecoder().decode(stored.bytes)
}

/** 那五个格子在不在界面上（模态收起就是把它们从树上摘掉） */
function cardIsOpen(m: Mount): boolean {
  return m.container.querySelector('#s3-sk') !== null
}

/**
 * 拖进来那一族用的那颗文件：真窗口里 drop 事件交出来的就是它，应用只拿它去换本机路径
 * （`fs.pathForFile`，替身按名字查对照表）——字节由后端按路径自己读，这里的内容只是样子货。
 */
function droppedFile(name: string, body = 'x'): File {
  return new File([body], name, { type: 'text/plain' })
}

/**
 * 拖着一份文件悬在窗口里、还没松手。
 *
 * SDK 那个 `dragOver` 不带 dataTransfer（它是给"悬停"这一档用的），而这一族要的就是
 * "拖的是文件"那一个判断，所以这里自己挂一个只带 types 的——浏览器怎么递这个事件不在判据之内。
 */
async function dragFilesOver(m: Mount): Promise<void> {
  await act(async () => {
    const ev = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'dataTransfer', { value: { types: ['Files'], dropEffect: '' } })
    m.container.dispatchEvent(ev)
  })
  await m.settle(2)
}

describe('连接：五个格子与它的记忆', () => {
  it('OS-001 第一次打开摊出那五个格子', async () => {
    const { m } = await openFresh()
    expect(m.text()).toContain('还没连上任何端点')
    for (const id of ['s3-name', 's3-endpoint', 's3-region', 's3-ak', 's3-sk']) {
      expect(m.container.querySelector(`#${id}`), `缺输入框 #${id}`).not.toBeNull()
    }
  })

  it('OS-002 端点不成形状就在原地念原因，一条请求都不发', async () => {
    const { m, s3 } = await openFresh()
    await fill(m, 's3-name', '家里的')
    await fill(m, 's3-endpoint', 'localhost:9000')
    await fill(m, 's3-ak', 'rustfsadmin')
    await fill(m, 's3-sk', 'rustfsadmin')
    await tapText(m, '连上')

    expect(m.text()).toContain('端点要以 http:// 或 https:// 开头，收到 localhost:9000')
    expect(s3.requests.length).toBe(0)
  })

  it('OS-003 少哪一样就念那一样的名字', async () => {
    const { m, s3, endpoint } = await openFresh()
    await fill(m, 's3-name', '家里的')
    await fill(m, 's3-endpoint', endpoint)
    await fill(m, 's3-sk', 'rustfsadmin')
    await tapText(m, '连上')

    expect(m.text()).toContain('Access Key 是空的')
    expect(s3.requests.length).toBe(0)
  })

  it('OS-004 连上之后顶栏那颗源键念得出这个源的名字', async () => {
    const { m, s3, endpoint } = await openFresh()
    await fill(m, 's3-name', '家里的')
    await fill(m, 's3-endpoint', endpoint)
    await fill(m, 's3-ak', 'rustfsadmin')
    await fill(m, 's3-sk', 'rustfsadmin')
    await tapText(m, '连上')

    expect(m.field('sources-toggle')?.textContent).toContain('家里的')
    // 那一列里这一行念的就是名字——主机不再出现在行里（2026-11-22 他点名去掉）
    await tap(m, '[data-test="sources-toggle"]')
    expect(m.field('pick:家里的')?.textContent).toContain('家里的')

    expect(m.has('demo')).toBe(true)
    expect(m.has('archive')).toBe(true)
    expect(s3.requests.some((r) => r.method === 'GET' && r.path === '/')).toBe(true)
  })

  it('OS-005 五样都记住，重开就直连', async () => {
    const first = await openFresh()
    await fill(first.m, 's3-name', '家里的')
    await fill(first.m, 's3-endpoint', first.endpoint)
    await fill(first.m, 's3-ak', 'rustfsadmin')
    await fill(first.m, 's3-sk', 'rustfsadmin')
    await tapText(first.m, '连上')
    expect(first.fake.settingsStore[SOURCES_KEY]).toMatchObject([
      { name: '家里的', endpoint: first.endpoint, secretAccessKey: 'rustfsadmin' }
    ])
    expect(first.fake.settingsStore[CURRENT_KEY]).toBe('家里的')
    first.m.unmount()

    // 同一份设置再开一次：不该再摊出那五个格子
    const again = await open({ name: '家里的' })
    expect(hasLabel(again.m, '连上')).toBe(false)
    expect(again.m.has('demo')).toBe(true)

    // 再摊开卡片，五格里念的还是上次那五样值
    await tapText(again.m, '连接设置')
    const values = ['s3-name', 's3-endpoint', 's3-region', 's3-ak', 's3-sk'].map(
      (id) => (again.m.container.querySelector(`#${id}`) as HTMLInputElement).value
    )
    expect(values).toEqual(['家里的', again.endpoint, 'us-east-1', 'rustfsadmin', 'rustfsadmin'])
  })

  it('OS-039 卡片按 Esc 或点它外面那层就收起', async () => {
    const { m } = await open()
    await tapText(m, '连接设置')
    expect(cardIsOpen(m)).toBe(true)
    await m.key('Escape')
    expect(cardIsOpen(m)).toBe(false)
    expect(m.field('sources-toggle')?.textContent).toContain('本机')
    expect(m.has('demo')).toBe(true)

    await tapText(m, '连接设置')
    await tap(m, '[data-test="modal-backdrop"]')
    expect(cardIsOpen(m)).toBe(false)
  })

  it('OS-040 一个源都没有时那五个格子收不掉', async () => {
    const { m } = await openFresh()
    expect(cardIsOpen(m)).toBe(true)
    await m.key('Escape')
    expect(cardIsOpen(m)).toBe(true)
    await tap(m, '[data-test="modal-backdrop"]')
    expect(cardIsOpen(m)).toBe(true)
    // 收不掉不等于走不通：那五个格子还摊着，可以直接填下一个
    expect(hasLabel(m, '连上')).toBe(true)
  })
})

describe('端点的话翻译成人能读的下一句', () => {
  it('OS-006 密钥被拒就念密钥被拒，不念端点内部的话', async () => {
    const { m, s3 } = await open()
    s3.denyAll = true
    await tapText(m, '刷新')

    expect(m.text()).toContain('端点拒绝了这个密钥（403）')
    expect(m.text()).not.toContain('AccessDenied')
  })

  it('OS-007 端点没人应答就念连不上', async () => {
    const dead = new FakeS3({ demo: {} })
    const endpoint = await dead.start()
    await dead.stop()

    const { fake } = newFake()
    fake.settingsStore[SOURCES_KEY] = [{ name: '关掉的', endpoint, region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' }]
    fake.settingsStore[CURRENT_KEY] = '关掉的'
    const m = await mountUi(<S3App api={fake.api} />, { fake })
    mounts.push(m)
    await quiet(m)

    expect(m.text()).toContain('连不上端点（')
    expect(m.has('demo')).toBe(false)
  })
})

describe('一层的对象：目录在前，翻得完', () => {
  const seed: Record<string, Record<string, SeedObject>> = {
    demo: {
      'logs/2026-11/run.txt': { body: '十一月那一份\n', type: 'text/plain; charset=utf-8' },
      'logs/2026-10/run.txt': { body: '十月那一份\n', type: 'text/plain; charset=utf-8' },
      '说明.txt': { body: '对象存储的中文文本。\n第二行也在这一段里。\n', type: 'text/plain; charset=utf-8' },
      'pic.png': { body: new Uint8Array([137, 80, 78, 71]), type: 'image/png' },
      'a.zip': { body: new Uint8Array(64), type: 'application/zip' }
    },
    archive: {},
    empty: {}
  }

  it('OS-008 选一个桶，列出它根下这一层', async () => {
    const { m } = await open({ seed })
    await enter(m, 'demo')

    expect(prefixRows(m)).toBe(1)
    expect(m.field('dir:logs/')?.textContent).toBe('logs/')
    // 目录行排在对象行之前
    expect(m.container.querySelector('tbody tr')?.textContent).toContain('logs/')
    expect(objectRows(m)).toBe(3)
    expect(m.has('说明.txt')).toBe(true)
    expect(m.text()).toContain('62 B')
    // 时间按本机时区念，所以只钉到那一天（小时数随机器变，不是判据）
    expect(m.text()).toContain('2026-11-08')
  })

  it('OS-009 进目录与回上一级是同一层的两面', async () => {
    const { m } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="dir:logs/"]')
    // logs/ 下面还有两层目录，这一层里没有直接挂着的对象
    expect(prefixRows(m)).toBe(2)
    expect(objectRows(m)).toBe(0)
    expect(m.has('2026-11/')).toBe(true)
    expect(m.text()).toContain('demo / logs/')

    await tap(m, '[data-test="crumb:-1"]')
    expect(objectRows(m)).toBe(3)
    expect(prefixRows(m)).toBe(1)
  })

  it('OS-010 这一格没有东西就这么说', async () => {
    const { m } = await open({ seed: { demo: { 'logs/': { body: '' } }, archive: {} } })
    await enter(m, 'demo')
    await tap(m, '[data-test="dir:logs/"]')
    expect(m.text()).toContain('这一格里没有东西')
  })

  it('OS-033 新建的目录也占一行，进去是空的', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    await tapText(m, '新建目录')
    await fill(m, 's3-newdir', 'pic')
    await tapText(m, '建')

    const marker = s3.object('demo', 'pic/')
    expect(marker, '端点上没有那个以斜杠结尾的零字节标记').toBeDefined()
    expect(marker!.bytes.byteLength).toBe(0)
    expect(m.field('dir:pic/')?.textContent).toBe('pic/')

    await tap(m, '[data-test="dir:pic/"]')
    expect(m.text()).toContain('这一格里没有东西')
  })

  it('OS-034 目录名带斜杠或空着就在原地念原因', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    const keys = (): number => [...s3.buckets.values()].reduce((n, dir) => n + dir.size, 0)
    const before = keys()

    await tapText(m, '新建目录')
    await fill(m, 's3-newdir', 'a/b')
    await tapText(m, '建')
    expect(m.text()).toContain('目录名里不要带斜杠，一次建一层')

    await fill(m, 's3-newdir', '')
    await tapText(m, '建')
    expect(m.text()).toContain('目录名是空的')
    expect(keys()).toBe(before)
  })

  it('OS-035 这一层里已经有同名目录就别再建一个', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    expect(m.has('logs/')).toBe(true)

    await tapText(m, '新建目录')
    await fill(m, 's3-newdir', 'logs')
    await tapText(m, '建')

    expect(m.text()).toContain('这一层里已经有叫 logs 的目录')
    expect(s3.requests.some((r) => r.method === 'PUT')).toBe(false)
  })

  it('OS-036 删掉空目录，那一行退掉', async () => {
    const { m, s3 } = await open({ seed: { demo: { 'pic/': { body: '' } }, archive: {} }, confirm: true })
    await enter(m, 'demo')
    expect(m.has('pic/')).toBe(true)
    await tap(m, '[data-test="rmdir:pic/"]')

    expect(s3.object('demo', 'pic/')).toBeUndefined()
    expect(m.container.querySelectorAll('[data-test="dir:pic/"]').length).toBe(0)
    expect(m.text()).toContain('已删掉目录 pic')
  })

  it('OS-037 里面还有对象时删掉的只是标记', async () => {
    const { m, s3 } = await open({
      seed: { demo: { 'logs/': { body: '' }, 'logs/run.txt': { body: '一份日志\n', type: 'text/plain' } }, archive: {} },
      confirm: true
    })
    await enter(m, 'demo')
    await tap(m, '[data-test="rmdir:logs/"]')

    expect(s3.object('demo', 'logs/')).toBeUndefined()
    expect(textOf(s3, 'demo', 'logs/run.txt')).toBe('一份日志\n')
    // 标记没了，行还在——那是里面的对象聚合出来的那一格
    expect(m.container.querySelectorAll('[data-test="dir:logs/"]').length).toBe(1)
    expect(m.text()).toContain('已去掉 logs 的目录标记，里面还有对象，这一行还在')
  })

  it('OS-038 从对象读出来的目录没有标记可删', async () => {
    const { m, s3 } = await open({ seed: { demo: { 'logs/run.txt': { body: '一份日志\n', type: 'text/plain' } }, archive: {} }, confirm: true })
    await enter(m, 'demo')
    await tap(m, '[data-test="rmdir:logs/"]')

    expect(m.text()).toContain('logs 是从里面的对象读出来的目录，没有单独的标记可删')
    // 弹问句之前先问过有没有标记：没有就一条删都不该发
    expect(s3.requests.some((r) => r.method === 'DELETE')).toBe(false)
    expect(s3.object('demo', 'logs/run.txt')).toBeDefined()
  })
})

describe('翻页：一段固定问 500 把键，端点回多少行就显示多少行', () => {
  it('OS-059 列层请求永远问 500 把键，页脚照实念行数', async () => {
    const { m, s3 } = await open({ seed: { demo: manyObjects(600), archive: {} } })
    await enter(m, 'demo')
    const lists = s3.requests.filter((r) => r.method === 'GET' && r.query.includes('list-type=2'))
    expect(lists.length).toBe(1)
    expect(lists[0]?.query).toContain('max-keys=500')
    expect(objectRows(m)).toBe(500)
    expect(pageText(m)).toBe('本页 500 个')
    expect(disabledOf(m, 'next')).toBe(false)
    expect(disabledOf(m, 'prev')).toBe(true)
  })

  it('OS-060 目录行把一段的键扣完，行数远少于 500 也不加问', async () => {
    const { m, s3 } = await open({ seed: { demo: dirLayer(30, 30), archive: {} } })
    await enter(m, 'demo')
    // 假端点按真账数键：每个目录扣 30 把，500 键的一段只装得下 17 行目录——应用不拼页，就这么画
    const lists = s3.requests.filter((r) => r.method === 'GET' && r.query.includes('list-type=2'))
    expect(lists.length).toBe(1)
    expect(prefixRows(m)).toBe(17)
    expect(pageText(m)).toBe('本页 17 个')
    expect(m.field('idx:d001/')?.textContent).toBe('1')

    await tap(m, '[data-test="next"]')
    expect(prefixRows(m)).toBe(13)
    expect(m.field('idx:d018/')?.textContent).toBe('1')
    expect(disabledOf(m, 'next')).toBe(true)
  })

  it('OS-061 一段装得下就没有下一页', async () => {
    const { m } = await open({ seed: { demo: manyObjects(60), archive: {} } })
    await enter(m, 'demo')
    expect(objectRows(m)).toBe(60)
    expect(pageText(m)).toBe('本页 60 个')
    expect(disabledOf(m, 'next')).toBe(true)
    expect(disabledOf(m, 'prev')).toBe(true)
  })

  it('OS-054 上一页回到刚读过的那一段', async () => {
    const { m } = await open({ seed: { demo: manyObjects(600), archive: {} } })
    await enter(m, 'demo')
    await tap(m, '[data-test="next"]')
    expect(objectRows(m)).toBe(100)
    expect(m.has('k501.txt')).toBe(true)
    await tap(m, '[data-test="prev"]')

    expect(pageText(m)).toBe('本页 500 个')
    expect(objectRows(m)).toBe(500)
    expect(m.has('k001.txt')).toBe(true)
    expect(m.has('k500.txt')).toBe(true)
    expect(m.has('k501.txt')).toBe(false)
  })

  it('OS-055 删掉一个对象停在当前段', async () => {
    const { m, s3 } = await open({ seed: { demo: manyObjects(600), archive: {} }, confirm: true })
    await enter(m, 'demo')
    await tap(m, '[data-test="next"]')
    await tap(m, '[data-test="del:k501.txt"]')

    expect(m.text()).toContain('已删掉 k501.txt')
    expect(s3.object('demo', 'k501.txt')).toBeUndefined()
    expect(pageText(m)).toBe('本页 99 个')
    expect(m.has('k502.txt')).toBe(true)
    expect(disabledOf(m, 'prev')).toBe(false)
  })

  it('OS-057 行号按段记，换段从 1 重新数', async () => {
    const { m } = await open({ seed: { demo: manyObjects(600), archive: {} } })
    await enter(m, 'demo')
    expect(m.field('idx:k001.txt')?.textContent).toBe('1')
    expect(m.field('idx:k500.txt')?.textContent).toBe('500')

    await tap(m, '[data-test="next"]')
    expect(m.field('idx:k501.txt')?.textContent).toBe('1')
    expect(m.field('idx:k600.txt')?.textContent).toBe('100')
  })
})

describe('上传与下载：字节要一样多', () => {
  it('OS-012 上传落在当前那一层', async () => {
    const { m, s3 } = await open({
      seed: { demo: { 'logs/keep.txt': { body: '已有\n', type: 'text/plain' } }, archive: {} },
      picks: [['/fake/in/a.txt', '/fake/in/b.txt']],
      files: { '/fake/in/a.txt': '甲的内容\n', '/fake/in/b.txt': '乙的内容\n' }
    })
    await enter(m, 'demo')
    await tap(m, '[data-test="dir:logs/"]')
    await tapText(m, '上传')
    await until(m, () => m.text().includes('已上传 2 个对象'))
    // 比解出来的文本而不是字节数组：假端点那份是 node 侧的 Uint8Array，
    // 用例这边是 jsdom 侧的，原型不同会让 toEqual 报"看起来一模一样却不相等"
    expect(textOf(s3, 'demo', 'logs/a.txt')).toBe('甲的内容\n')
    expect(textOf(s3, 'demo', 'logs/b.txt')).toBe('乙的内容\n')
    expect(m.text()).toContain('已上传 2 个对象')
  })

  it('OS-013 大文件分段传完，端点上那份与本地一样长', async () => {
    const size = 40 * MB
    const body = new Uint8Array(size)
    body[0] = 7
    body[size - 1] = 9
    const { m, s3 } = await open({
      picks: [['/fake/in/big.bin']],
      files: { '/fake/in/big.bin': body }
    })
    await enter(m, 'demo')
    await tapText(m, '上传')
    // 分段上传比一次列表慢得多：等顶栏念出那句回执
    await until(m, () => m.text().includes('已上传 1 个对象'))

    const stored = s3.object('demo', 'big.bin')
    expect(stored?.bytes.byteLength).toBe(size)
    expect(stored?.bytes[0]).toBe(7)
    expect(stored?.bytes[size - 1]).toBe(9)
    // 40 MB 按 8 MB 一段：五段，一段不少
    expect(s3.requests.filter((r) => r.method === 'PUT' && r.query.includes('partNumber=')).length).toBe(5)
    expect(m.text()).toContain('已上传 1 个对象')
  })

  it('OS-014 下载存到选定的位置，字节一致', async () => {
    const text = '对象存储的中文文本。\n第二行也在这一段里。\n'
    const { m, fake } = await open({
      seed: { demo: { '说明.txt': { body: text, type: 'text/plain; charset=utf-8' } }, archive: {} },
      picks: ['/fake/out/说明.txt']
    })
    await enter(m, 'demo')
    await tap(m, '[data-test="dl:说明.txt"]')

    expect(fake.text('/fake/out/说明.txt')).toBe(text)
    expect(m.text()).toContain('已下载 说明.txt')
  })

  it('OS-063 下载到一半断了线，落点上不留半份文件', async () => {
    const { m, fake, s3 } = await open({
      seed: { demo: { '半份.txt': { body: '断之前到过一段', type: 'text/plain' } }, archive: {} },
      picks: ['/fake/out/半份.txt']
    })
    // 报 128 KB、只发 1 KB 就拆连接：对面收到的就是一句断线
    s3.streamGet = { bucket: 'demo', key: '半份.txt', totalBytes: 128 * 1024, cutAfterBytes: 1024 }
    await enter(m, 'demo')
    await tap(m, '[data-test="dl:半份.txt"]')
    await until(m, () => m.text().includes('连不上端点（'), 3000)

    expect(fake.vol.has('/fake/out/半份.txt')).toBe(false)
    expect(m.text()).not.toContain('已下载')
  })

  it('OS-064 端点上报 300 MB 的对象照下载，没有拒收句', async () => {
    const huge = 300 * MB
    const { m, s3, written } = await open({
      seed: { demo: { 'huge.bin': { body: '', type: 'application/octet-stream', sizeHint: huge } }, archive: {} },
      picks: ['/fake/out/huge.bin']
    })
    // 假端点把同一块 64 KB 反复流到报的字节数：不真分配 300 MB，链路上的字节却是真的
    s3.streamGet = { bucket: 'demo', key: 'huge.bin', totalBytes: huge }
    await enter(m, 'demo')
    await tap(m, '[data-test="dl:huge.bin"]')
    await until(m, () => m.text().includes('已下载 huge.bin'))

    expect(m.text()).not.toContain('超过')
    expect(m.text()).not.toContain('拒')
    expect(written.get('/fake/out/huge.bin')).toBe(huge)
  })

  it('OS-065 后端进程半路没了，正在传的就地判失败', async () => {
    const size = 40 * MB
    const body = new Uint8Array(size)
    const { m, fake } = await open({
      picks: [['/fake/in/big.bin']],
      files: { '/fake/in/big.bin': body },
      // 每段字节前都等一下：传输确实"还在进行中"，退出那一刻才判得干净
      ioDelay: 40
    })
    await enter(m, 'demo')
    const up = m.field('upload') as HTMLButtonElement | null
    expect(up, '找不到上传键').not.toBeNull()
    await act(async () => {
      up!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    for (let i = 0; i < 100 && !m.text().includes('正在上传'); i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5))
      })
    }
    expect(m.text()).toContain('正在上传')
    await act(async () => {
      fake.emit({ kind: 'backend:exited' })
    })
    await until(m, () => m.text().includes('后端程序中途退出，正在传的东西没传完'))

    expect(m.text()).not.toContain('正在上传')
    // 40 MB 的 multipart 走完整条假端点实测要 5 秒上下，默认 5 秒线太贴，给这条单开超时
  }, 20_000)

  it('OS-041 拖着一份文件悬在窗口上、还没松手，念得出落点', async () => {
    const { m, s3 } = await open({
      seed: { demo: { 'logs/keep.txt': { body: '已有\n', type: 'text/plain' } }, archive: {} }
    })
    await enter(m, 'demo')
    await dragFilesOver(m)
    expect(m.text()).toContain('松手就传到 demo 根下')

    await tap(m, '[data-test="dir:logs/"]')
    await dragFilesOver(m)
    expect(m.text()).toContain('松手就传到 demo/logs/')
    // 还没松手就一个字节都不该动
    expect(s3.requests.filter((r) => r.method === 'PUT').length).toBe(0)
  })

  it('OS-042 拖进来松手就传到当前那一层', async () => {
    const { m, s3 } = await open({
      seed: { demo: { 'logs/keep.txt': { body: '已有\n', type: 'text/plain' } }, archive: {} },
      files: { '/fake/drop/甲.txt': '甲的内容\n', '/fake/drop/乙.txt': '乙的内容\n' },
      dropPaths: { '甲.txt': '/fake/drop/甲.txt', '乙.txt': '/fake/drop/乙.txt' }
    })
    await enter(m, 'demo')
    await tap(m, '[data-test="dir:logs/"]')
    await m.dropFiles('.s3', [droppedFile('甲.txt'), droppedFile('乙.txt')])
    await until(m, () => m.text().includes('已上传 2 个对象'))

    expect(textOf(s3, 'demo', 'logs/甲.txt')).toBe('甲的内容\n')
    expect(textOf(s3, 'demo', 'logs/乙.txt')).toBe('乙的内容\n')
    expect(m.has('甲.txt')).toBe(true)
    expect(m.has('乙.txt')).toBe(true)
    // 松手之后那句落点就退场了
    expect(m.text()).not.toContain('松手就传到')
  })

  it('OS-043 还没选桶时松手，说清楚缺的是哪一步', async () => {
    const { m, s3 } = await open()
    await m.dropFiles('.s3', [droppedFile('甲.txt', '甲的内容\n')])
    await quiet(m)

    expect(m.text()).toContain('左边先选一个桶，拖进来的文件才有落点')
    expect(s3.requests.filter((r) => r.method === 'PUT').length).toBe(0)
  })

  it('OS-044 连接卡摊着时拖进来的东西不动', async () => {
    const { m, s3 } = await openFresh()
    await m.dropFiles('.s3', [droppedFile('甲.txt', '甲的内容\n')])
    await quiet(m)

    expect(cardIsOpen(m)).toBe(true)
    expect(s3.requests.length).toBe(0)
  })

  it('OS-045 拖进来的那一样读不出来就念这一句', async () => {
    const { m, s3 } = await open()
    await enter(m, 'demo')
    // 文件夹在拖放里也是一颗"文件"：换不出本机路径（替身对照表里没有它），后端在它自己的盘上也读不到
    await m.dropFiles('.s3', [droppedFile('logs')])
    await until(m, () => m.text().includes('拖进来的那一样读不出来，没上传'))

    expect(s3.requests.filter((r) => r.method === 'PUT').length).toBe(0)
    expect(s3.object('demo', 'logs')).toBeUndefined()
  })
})

describe('预览只给认得出的类型', () => {
  const seed: Record<string, Record<string, SeedObject>> = {
    demo: {
      '说明.txt': { body: '对象存储的中文文本。\n第二行也在这一段里。\n', type: 'text/plain; charset=utf-8' },
      'pic.png': { body: new Uint8Array([137, 80, 78, 71]), type: 'image/png' },
      'a.zip': { body: new Uint8Array(64), type: 'application/zip' },
      'long.txt': { body: new Uint8Array(9 * MB), type: 'text/plain; charset=utf-8' }
    },
    archive: {}
  }

  async function openAndSelect(key: string): Promise<Mount> {
    const opened = await open({ seed })
    await enter(opened.m, 'demo')
    await tap(opened.m, `[data-test="row:${key}"]`)
    return opened.m
  }

  it('OS-016 文本对象读得出原文，中文不乱', async () => {
    const m = await openAndSelect('说明.txt')
    expect(m.text()).toContain('对象存储的中文文本。')
    expect(m.text()).toContain('第二行也在这一段里。')
  })

  it('OS-017 图片对象给的是本地生成的图像地址', async () => {
    Object.defineProperty(globalThis.URL, 'createObjectURL', {
      value: () => 'blob:airship://s3/from-stub',
      configurable: true,
      writable: true
    })
    Object.defineProperty(globalThis.URL, 'revokeObjectURL', { value: () => undefined, configurable: true, writable: true })

    const m = await openAndSelect('pic.png')
    const src = m.container.querySelector('img')?.getAttribute('src')
    expect(src).toBe('blob:airship://s3/from-stub')
    expect(src).not.toContain('127.0.0.1')
  })

  it('OS-018 认不出的类型不预览，并说清是哪个类型', async () => {
    const m = await openAndSelect('a.zip')
    expect(m.text()).toContain('这种类型不预览（application/zip）')
  })

  it('OS-019 预览有上限，超了就报两个数', async () => {
    const opened = await open({ seed })
    await enter(opened.m, 'demo')
    const before = opened.s3.requests.length
    await tap(opened.m, '[data-test="row:long.txt"]')
    await until(opened.m, () => opened.m.text().includes('超过预览的 8 MB'))

    expect(opened.m.text()).toContain('有 9 MB，超过预览的 8 MB')
    // 说一句"太大不预览"不该先把那九兆整份搬回来：只许问一次详情
    const got = opened.s3.requests.slice(before).filter((r) => r.method === 'GET')
    expect(got.length).toBe(0)
  })
})

describe('破坏性动作先问一句，建桶与链接各说一句人话', () => {
  const seed: Record<string, Record<string, SeedObject>> = {
    demo: { '说明.txt': { body: '要删的那一份\n', type: 'text/plain; charset=utf-8' } },
    archive: {}
  }

  it('OS-020 问一句，答"否"就什么都不动', async () => {
    const { m, s3 } = await open({ seed, confirm: false })
    await enter(m, 'demo')
    await tap(m, '[data-test="del:说明.txt"]')

    expect(s3.object('demo', '说明.txt')).toBeDefined()
    expect(m.has('说明.txt')).toBe(true)
    expect(m.text()).not.toContain('已删掉')
  })

  it('OS-021 答"是"之后端点上就没了', async () => {
    const { m, s3 } = await open({ seed, confirm: true })
    await enter(m, 'demo')
    await tap(m, '[data-test="del:说明.txt"]')

    expect(s3.object('demo', '说明.txt')).toBeUndefined()
    // 顶栏那句回执里也带着这个名字，所以判"行退掉了"要看行本身
    expect(m.container.querySelectorAll('[data-test="row:说明.txt"]').length).toBe(0)
    expect(m.text()).toContain('已删掉 说明.txt')
  })

  it('OS-022 桶名不合，念出具体那一条', async () => {
    const { m, s3 } = await open({ seed })
    await tapText(m, '新建桶')
    await fill(m, 's3-newbucket', 'My_Bucket')
    await tapText(m, '建')

    expect(m.text()).toContain('桶名只能用小写字母、数字与连字符')
    expect(s3.buckets.has('My_Bucket')).toBe(false)
  })

  it('OS-023 名字合格就建好并进左栏', async () => {
    const { m, s3 } = await open({ seed })
    await tapText(m, '新建桶')
    await fill(m, 's3-newbucket', 'new-demo')
    await tapText(m, '建')

    expect(s3.buckets.has('new-demo')).toBe(true)
    expect(m.has('new-demo')).toBe(true)
    expect(m.text()).toContain('已建好桶 new-demo')
  })

  it('OS-024 复制临时链接进剪贴板，并把有效期念出来', async () => {
    const { m, fake, host } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="link:说明.txt"]')

    const link = fake.clipboardText
    expect(link).toContain('X-Amz-Signature')
    expect(link).toContain('X-Amz-Expires=3600')
    expect(link).toContain(`${host}/demo/`)
    expect(m.text()).toContain('临时链接已复制，一小时内有效')
  })

  it('OS-025 编辑当前源换了端点，旧端点的桶读不到', async () => {
    const first = await open({ seed: { 'only-one': {}, archive: {} } })
    expect(first.m.has('only-one')).toBe(true)

    // 换一家：另一台假端点，顶栏那颗「连接设置」改的就是当前这个源
    const second = new FakeS3({ 'only-two': {} })
    const other = await second.start()
    stoppers.push(() => second.stop())

    await tapText(first.m, '连接设置')
    await fill(first.m, 's3-endpoint', other)
    await tapText(first.m, '存下')

    expect(first.m.has('only-two')).toBe(true)
    expect(first.m.has('only-one')).toBe(false)
  })
})

describe('重命名：只有对象行有这一颗', () => {
  const seed: Record<string, Record<string, SeedObject>> = {
    demo: {
      '说明.txt': { body: '要改名的那一份\n', type: 'text/plain; charset=utf-8' },
      'pic.png': { body: new Uint8Array([137, 80, 78, 71]), type: 'image/png' },
      'logs/run.txt': { body: '一份日志\n', type: 'text/plain' },
      'huge.bin': { body: '', type: 'application/octet-stream', sizeHint: 6 * 1024 * MB }
    },
    archive: {}
  }

  /** 假端点收到过的写请求（复制是带 copy-source 头的 PUT，删除是 DELETE） */
  function writeRequests(s3: FakeS3): number {
    return s3.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE' || r.method === 'POST').length
  }

  it('OS-046 重命名一个对象，端点上换了键、字节没动', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="ren:说明.txt"]')

    // 居中模态：念得出改的是哪一个键，格子里预填的就是当前名字
    expect(m.text()).toContain('把 demo/说明.txt 改成：')
    expect((m.container.querySelector('#s3-rename') as HTMLInputElement).value).toBe('说明.txt')
    await fill(m, 's3-rename', '备注.txt')
    await tapText(m, '改')

    expect(textOf(s3, 'demo', '备注.txt')).toBe('要改名的那一份\n')
    expect(s3.object('demo', '说明.txt')).toBeUndefined()
    expect(m.has('备注.txt')).toBe(true)
    expect(m.container.querySelectorAll('[data-test="row:说明.txt"]').length).toBe(0)
    expect(m.text()).toContain('已重命名 说明.txt → 备注.txt')
  })

  it('OS-047 新名字空着、带斜杠或没变，就在原地念原因', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="ren:说明.txt"]')
    const before = writeRequests(s3)

    await fill(m, 's3-rename', 'a/b')
    await tapText(m, '改')
    expect(m.text()).toContain('新名字里不要带斜杠，一次只改这一层的名字')

    await fill(m, 's3-rename', '')
    await tapText(m, '改')
    expect(m.text()).toContain('新名字是空的')

    await fill(m, 's3-rename', '说明.txt')
    await tapText(m, '改')
    expect(m.text()).toContain('名字没变，什么都没动')
    expect(writeRequests(s3)).toBe(before)
  })

  it('OS-048 这一层里已经有同名对象就别盖上去', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="ren:说明.txt"]')
    const png = s3.object('demo', 'pic.png')
    const before = writeRequests(s3)

    await fill(m, 's3-rename', 'pic.png')
    await tapText(m, '改')

    expect(m.text()).toContain('这一层里已经有叫 pic.png 的对象')
    expect(s3.object('demo', '说明.txt')).toBeDefined()
    expect(s3.object('demo', 'pic.png')).toBe(png)
    expect(writeRequests(s3)).toBe(before)
  })

  it('OS-049 超过服务端一次复制上限的，动手之前就拒并报两个数', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')
    await tap(m, '[data-test="ren:huge.bin"]')

    expect(m.text()).toContain('这个对象有 6.0 GB，超过服务端一次复制的 5 GB，改不了')
    // 拒在摊模态之前：模态根本不出现，端点也没收到写请求
    expect(m.container.querySelector('#s3-rename')).toBeNull()
    expect(writeRequests(s3)).toBe(0)
  })

  it('OS-050 目录行与桶行没有重命名这一颗', async () => {
    const { m } = await open({ seed })
    await enter(m, 'demo')
    expect(m.has('logs/')).toBe(true)

    const dirRow = m.field('dir:logs/')?.closest('tr')
    expect(dirRow?.querySelectorAll('[data-test^="ren:"]').length).toBe(0)
    // 左栏的桶行里读不到这句话
    expect(m.container.querySelector('nav')?.textContent).not.toContain('重命名')
    // 每一颗重命名键都挂在对象行上（这一层里对象共三行，logs/ 是目录行）
    const renKeys = [...m.container.querySelectorAll('[data-test^="ren:"]')].map((e) => e.getAttribute('data-test')!.slice(4))
    expect(renKeys.length).toBe(3)
    for (const key of renKeys) {
      expect(m.container.querySelector(`[data-test="row:${key}"]`), `ren:${key} 不在对象行上`).not.toBeNull()
    }
  })

  it('OS-051 改名模态按取消、Esc 或点它外面那层就收起，端点什么都没动', async () => {
    const { m, s3 } = await open({ seed })
    await enter(m, 'demo')

    await tap(m, '[data-test="ren:说明.txt"]')
    await fill(m, 's3-rename', '改成谁都不算')
    await tapText(m, '取消')
    expect(m.container.querySelector('#s3-rename')).toBeNull()

    await tap(m, '[data-test="ren:pic.png"]')
    await m.key('Escape')
    expect(m.container.querySelector('#s3-rename')).toBeNull()

    await tap(m, '[data-test="ren:说明.txt"]')
    await tap(m, '[data-test="rename-backdrop"]')
    expect(m.container.querySelector('#s3-rename')).toBeNull()

    expect(s3.object('demo', '说明.txt')).toBeDefined()
    expect(s3.object('demo', 'pic.png')).toBeDefined()
    expect(s3.object('demo', 'logs/run.txt')).toBeDefined()
    expect(writeRequests(s3)).toBe(0)
  })
})

describe('一台机器上的多个源', () => {
  /** 先开一个源，再走源键面板里那行「添加源」加第二个（两台假端点各占一个端口） */
  async function openTwo(options: { confirm?: boolean } = {}): Promise<Opened & { second: FakeS3; endpoint2: string; host2: string }> {
    const opened = await open({ seed: { 'only-one': {} }, confirm: options.confirm })
    const second = new FakeS3({ 'only-two': {} })
    const endpoint2 = await second.start()
    stoppers.push(() => second.stop())

    await tap(opened.m, '[data-test="sources-toggle"]')
    await tap(opened.m, '[data-test="sources-add"]')
    await fill(opened.m, 's3-name', '另一家')
    await fill(opened.m, 's3-endpoint', endpoint2)
    await fill(opened.m, 's3-ak', 'rustfsadmin')
    await fill(opened.m, 's3-sk', 'rustfsadmin')
    await tapText(opened.m, '连上')

    return { ...opened, second, endpoint2, host2: new URL(endpoint2).host }
  }

  /** 源键面板里那一列的名字，按出现顺序 */
  function rowNames(m: Mount): string[] {
    return [...m.container.querySelectorAll('[data-test^="pick:"]')].map((e) => e.getAttribute('data-test')!.slice(5))
  }

  it('OS-026 添加源之后那一列念得出两个名字，「添加源」在最后', async () => {
    const { m } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')

    expect(rowNames(m)).toEqual(['本机', '另一家'])
    // 「添加源」排在两枚源之后，是这一列的最后一行
    const rows = [...m.container.querySelectorAll('.s3__menu-row')]
    expect(rows[rows.length - 1]?.getAttribute('data-test')).toBe('sources-add')
  })

  it('OS-027 点另一枚源，桶列表整个换成那一份', async () => {
    const { m } = await openTwo()
    expect(m.has('only-two')).toBe(true)

    await tap(m, '[data-test="sources-toggle"]')
    await tap(m, '[data-test="pick:本机"]')

    expect(m.has('only-one')).toBe(true)
    expect(m.has('only-two')).toBe(false)
  })

  it('OS-028 那一列里只有当前那一个带"当前"那一档底色', async () => {
    const { m } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')
    expect(m.field('pick:另一家')?.className).toContain('s3__menu-row--on')
    expect(m.field('pick:本机')?.className).not.toContain('s3__menu-row--on')

    await tap(m, '[data-test="pick:本机"]')
    await tap(m, '[data-test="sources-toggle"]')
    expect(m.field('pick:本机')?.className).toContain('s3__menu-row--on')
    expect(m.field('pick:另一家')?.className).not.toContain('s3__menu-row--on')
  })

  it('OS-029 重开回到上次用的那一个源', async () => {
    const { m, fake } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')
    await tap(m, '[data-test="pick:本机"]')
    m.unmount()

    // 同一份设置再开一次：源键上念的是上次点的那个，两个源都还在
    const again = await mountUi(<S3App api={fake.api} />, { fake })
    mounts.push(again)
    await quiet(again)
    expect(again.field('sources-toggle')?.textContent).toContain('本机')
    expect(again.has('only-one')).toBe(true)
    await tap(again, '[data-test="sources-toggle"]')
    expect(rowNames(again)).toEqual(['本机', '另一家'])
  })

  it('OS-030 名字重了当场说，那一列不多出一行', async () => {
    const { m } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')
    await tap(m, '[data-test="sources-add"]')
    await fill(m, 's3-name', '本机')
    await fill(m, 's3-ak', 'rustfsadmin')
    await fill(m, 's3-sk', 'rustfsadmin')
    await tapText(m, '连上')

    expect(m.text()).toContain('已经有叫「本机」的源了，换个名字')
    await tap(m, '[data-test="sources-toggle"]')
    expect(rowNames(m)).toEqual(['本机', '另一家'])
  })

  it('OS-031 从连接卡里删掉当前源，剩下那一个顶上并列出它的桶', async () => {
    const { m, fake } = await openTwo({ confirm: true })
    await tapText(m, '连接设置')
    await tap(m, '[data-test="source-remove"]')

    expect(m.field('sources-toggle')?.textContent).toContain('本机')
    expect(m.has('only-one')).toBe(true)
    expect(m.has('only-two')).toBe(false)
    expect(fake.settingsStore[SOURCES_KEY]).toHaveLength(1)
    expect(fake.settingsStore[CURRENT_KEY]).toBe('本机')
  })

  it('OS-032 只剩一个时删掉，回到没连上的样子并把卡留着填下一个', async () => {
    const { m, fake } = await open({ seed: { 'only-one': {} }, confirm: true })
    await tapText(m, '连接设置')
    await tap(m, '[data-test="source-remove"]')

    expect(m.field('sources-toggle')?.textContent).toContain('还没连上任何端点')
    expect(hasLabel(m, '连上')).toBe(true)
    expect(fake.settingsStore[SOURCES_KEY]).toEqual([])

    await tap(m, '[data-test="sources-toggle"]')
    expect(rowNames(m)).toEqual([])
    expect(m.has('添加源')).toBe(true)
  })

  it('OS-062 卡顶念得出是新增还是修改', async () => {
    const { m } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')
    await tap(m, '[data-test="sources-add"]')
    expect(m.has('添加源')).toBe(true)
    expect(m.has('修改源')).toBe(false)

    await tapText(m, '取消')
    await tapText(m, '连接设置')
    expect(m.has('修改源')).toBe(true)
    expect(m.has('添加源')).toBe(false)
  })
})
