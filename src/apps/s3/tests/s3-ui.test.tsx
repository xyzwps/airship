// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeAirship, mountUi, type Mount } from '@airship/sdk/testing'
import S3App from '../s3App.tsx'
import { app } from '../app.ts'
import { CURRENT_KEY, SOURCES_KEY, type Source } from '../connection.ts'
import { FakeS3, type Content, type SeedObject } from './helpers/fakeS3.ts'

/**
 * OS 册子的影子：界面读得到哪句话、点下去变成什么。
 *
 * 网络那一边是 `helpers/fakeS3.ts` 那个内存端点——它是一个真起在 127.0.0.1 上的 HTTP 服务，
 * 按 S3 的线格式回话，所以签名、分段、XML 解析这一整条链是原样跑过的
 * （换 `globalThis.fetch` 拦不到：测试里 SDK 挑的是 Node 那一档传输）。
 *
 * 浏览器里那条传输——也就是出包后那个窗口真正用的那一条——不在这里验，
 * 归 `just shot` 连真 RustFS：上传、列层、详情、中文预览都在那张截图里看得见。
 */

const MB = 1024 * 1024

interface OpenOptions {
  seed?: Record<string, Record<string, SeedObject>>
  files?: Record<string, Content>
  picks?: Array<string[] | string | null>
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
}

const stoppers: Array<() => Promise<void>> = []
const mounts: Mount[] = []

async function open(options: OpenOptions = {}): Promise<Opened> {
  const s3 = new FakeS3(options.seed ?? { demo: {}, archive: {} })
  const endpoint = await s3.start()
  stoppers.push(() => s3.stop())
  const host = new URL(endpoint).host

  const fake = new FakeAirship({ id: app.id, capabilities: app.capabilities, files: options.files, picks: options.picks })
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
  return { m, fake, s3, endpoint, host, source }
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

async function tapText(m: Mount, label: string): Promise<void> {
  await m.press(label)
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

/** 假端点上那个对象现在的文本内容（没有这个对象就是空串） */
function textOf(s3: FakeS3, bucket: string, key: string): string {
  const stored = s3.object(bucket, key)
  return stored === undefined ? '' : new TextDecoder().decode(stored.bytes)
}

describe('连接：五个格子与它的记忆', () => {
  it('OS-001 第一次打开摊出那五个格子', async () => {
    const { m } = await openFresh()
    expect(m.text()).toContain('还没连上任何端点')
    for (const id of ['s3-name', 's3-endpoint', 's3-region', 's3-ak', 's3-sk']) {
      expect(m.container.querySelector(`#${id}`), `缺输入框 #${id}`).not.toBeNull()
    }
    expect(m.text()).toContain('五个格子都存进本机设置，Secret Key 是明文。')
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
    const { m, s3, endpoint, host } = await openFresh()
    await fill(m, 's3-name', '家里的')
    await fill(m, 's3-endpoint', endpoint)
    await fill(m, 's3-ak', 'rustfsadmin')
    await fill(m, 's3-sk', 'rustfsadmin')
    await tapText(m, '连上')

    expect(m.field('sources-toggle')?.textContent).toContain('家里的')
    // 主机与端口在那一列里念得出（点开源键才看得见）
    await tap(m, '[data-test="sources-toggle"]')
    expect(m.text()).toContain(host)

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
    expect(again.m.has('连上')).toBe(false)
    expect(again.m.has('demo')).toBe(true)
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

    const fake = new FakeAirship({ id: app.id, capabilities: app.capabilities })
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

    await tapText(m, '上一级')
    expect(objectRows(m)).toBe(3)
    expect(prefixRows(m)).toBe(1)
  })

  it('OS-010 这一格没有东西就这么说', async () => {
    const { m } = await open({ seed: { demo: { 'logs/': { body: '' } }, archive: {} } })
    await enter(m, 'demo')
    await tap(m, '[data-test="dir:logs/"]')
    expect(m.text()).toContain('这一格里没有东西')
  })

  it('OS-011 一页装不下就给「还有更多」，按下不清空已有的', async () => {
    const many: Record<string, SeedObject> = {}
    for (let i = 1; i <= 501; i += 1) many[`k${String(i).padStart(3, '0')}.txt`] = { body: 'x', type: 'text/plain' }
    const { m } = await open({ seed: { demo: many, archive: {} } })
    await enter(m, 'demo')

    expect(objectRows(m)).toBe(500)
    expect(m.has('还有更多')).toBe(true)
    await tapText(m, '还有更多')
    expect(objectRows(m)).toBe(501)
    expect(m.has('k001.txt')).toBe(true)
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

  it('OS-015 一次接不下的，动手之前就拒', async () => {
    const { m, fake } = await open({
      seed: { demo: { 'huge.bin': { body: '', type: 'application/octet-stream', sizeHint: 300 * MB } }, archive: {} },
      picks: ['/fake/out/huge.bin']
    })
    await enter(m, 'demo')
    await tap(m, '[data-test="dl:huge.bin"]')

    expect(m.text()).toContain('这个对象有 300 MB，超过一次能接的 256 MB')
    expect(fake.vol.has('/fake/out/huge.bin')).toBe(false)
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

  it('OS-026 添加源之后那一列念得出两个名字与各自主机，「添加源」在最后', async () => {
    const { m, host, host2 } = await openTwo()
    await tap(m, '[data-test="sources-toggle"]')

    expect(rowNames(m)).toEqual(['本机', '另一家'])
    expect(m.field('pick:本机')?.textContent).toContain(host)
    expect(m.field('pick:另一家')?.textContent).toContain(host2)
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
    expect(m.has('连上')).toBe(true)
    expect(fake.settingsStore[SOURCES_KEY]).toEqual([])

    await tap(m, '[data-test="sources-toggle"]')
    expect(rowNames(m)).toEqual([])
    expect(m.has('添加源')).toBe(true)
  })
})
