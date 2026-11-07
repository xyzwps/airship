import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import WsldApp from '../WsldApp'
import { FakeAirship, type FakeOptions } from '@airship/sdk/testing'
import { mountUi, type Mount } from '@airship/sdk/testing'
import type { AppApi } from '@airship/contract'
import type { ProcResult } from '@airship/contract'

/**
 * 容器台用例的公共工装。
 *
 * 一切外部事实都从 FakeAirship 编排：`toolPaths.wslc` 决定"这台机器上有没有 wslc"，
 * `run` 决定一次性调用的应答，`start` + `ctl` 决定流式任务什么时候结束、吐出什么。
 * 断言只落在可观察结果上：界面文字、`fake.procCalls` 里真实发出的命令行、事件流。
 */

export const WSLC_EXE = 'C:/fake/wslc.exe'

const CAPS = ['fs.read', 'fs.write', 'dialog', 'settings', 'proc', 'notify', 'clipboard', 'log']

export interface FakeSetup {
  /** 一次性调用的应答；不给就是干净退出 */
  run?: (exe: string, args: string[]) => Partial<ProcResult>
  /** 流式任务：用例自己用 ctl.chunk / ctl.exit 喂 */
  start?: FakeOptions['start']
  /** 这台机器上没有 wslc 时传 null；默认有 */
  wslc?: string | null
  confirm?: boolean
}

export function makeFake(setup: FakeSetup = {}): FakeAirship {
  return new FakeAirship({
    id: 'wsld',
    capabilities: [...CAPS],
    tools: ['wslc'],
    toolPaths: { wslc: setup.wslc === undefined ? WSLC_EXE : setup.wslc },
    run: setup.run,
    start: setup.start
  })
}

const mounted: Mount[] = []

export async function mountWsld(fake: FakeAirship, confirm = true): Promise<Mount> {
  const m = await mountUi(<WsldApp api={appApiOf(fake)} />, { fake, confirm })
  mounted.push(m)
  return m
}

/** 点开的窗口一律收掉：留着上一用例的残骸会让这一用例的界面查询认岔对象 */
export function unmountAll(): void {
  while (mounted.length > 0) mounted.pop()?.unmount()
}

/**
 * 装配成应用真正拿到的 AppApi。
 *
 * 替身的 `.api` 是把实例摊开成一个对象，原型上的方法（on / paths / theme）跟着丢了，
 * 而容器台要订阅子进程事件——所以这里把这三颗补回来，语义仍然由替身自己判。
 */
export function appApiOf(fake: FakeAirship): AppApi {
  return {
    ...fake.api,
    on: (listener) => fake.on(listener),
    paths: () => fake.paths(),
    theme: () => fake.theme()
  }
}

/** 按 data-test 点：文本相同的多颗键（行上的「启动」与详情头部的「启动」）靠它区分 */
export async function tap(m: Mount, name: string): Promise<void> {
  const el = m.field(name)
  if (!el) throw new Error(`界面上找不到名为「${name}」的控件`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await m.settle()
}

/** 把确认框的问话抄下来，并按用例给的答案答它 */
export function askConfirm(answer: boolean): string[] {
  const asked: string[] = []
  Object.defineProperty(globalThis, 'confirm', {
    configurable: true,
    writable: true,
    value: (message?: string) => {
      asked.push(String(message ?? ''))
      return answer
    }
  })
  return asked
}

/** 真发出的命令行，形如 `wslc list -a --format json`；册子里允许出现命令行，那是系统边界 */
export function commands(fake: FakeAirship): string[] {
  return fake.procCalls.map((call) => `wslc ${call.args.join(' ')}`)
}

export function countOf(fake: FakeAirship, needle: string): number {
  return commands(fake).filter((line) => line.includes(needle)).length
}

/* ---------------- 真样本 ---------------- */

/**
 * wslc 3.0.1 的真实输出，跟着用例放在本目录的 fixtures/ 下。
 * 解析类断言一律吃这些样本，不手搓假 JSON——真输出换个排版也要能被吃下，那才是要钉的东西。
 */
export const sample = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8')

export const listRunning = (): string => sample('wslc-list-running.ndjson')
export const listExited = (): string => sample('wslc-list-exited.ndjson')
export const listEmpty = (): string => sample('wslc-list-empty.ndjson')
export const imagesNdjson = (): string => sample('wslc-images.ndjson')
export const imagesUntagged = (): string => sample('wslc-images-untagged.ndjson')
export const logsPlain = (): string => sample('wslc-logs.txt')
export const logsStamped = (): string => sample('wslc-logs-timestamps.txt')
export const logsNotFound = (): string => sample('wslc-logs-not-found.txt')
export const logsUsage = (): string => sample('wslc-logs-usage-error.txt')
export const pullNew = (): string => sample('wslc-pull-new.txt')
export const pullUpToDate = (): string => sample('wslc-pull-uptodate.txt')

/** 按行拆开 NDJSON 样本（真实字段形态，改哪一格自己说） */
export function rows(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export const ndjson = (list: readonly Record<string, unknown>[]): string =>
  list.map((row) => JSON.stringify(row)).join('\n')

/**
 * 两台容器：一台在跑、一台已停，字段全抄真样本，只换标识与状态。
 * 真样本本身各自只有一行，够不上"排序"这类要看两行以上的判据。
 */
export function twoContainers(): string {
  const [running] = rows(listRunning())
  const [exited] = rows(listExited())
  if (!running || !exited) throw new Error('真样本读不出容器行')
  return ndjson([
    { ...running, ID: 'bbbb22222222', Names: 'zeta', State: 'running', Status: 'Up Less than a second' },
    {
      ...exited,
      ID: 'aaaa11111111',
      Names: '/alpha',
      State: 'exited',
      Status: 'Exited (0) 2 minutes ago',
      Image: 'docker.1ms.run/library/hello-world:latest'
    }
  ])
}

/** 同一个镜像 ID 带两个标签：真样本里那两行改出来的 */
export function twoTags(): string {
  const [busy] = rows(imagesNdjson())
  if (!busy) throw new Error('真样本读不出镜像行')
  return ndjson([
    { ...busy, Tag: 'latest' },
    { ...busy, Tag: 'backup' },
    { ...busy, ID: 'e2ac70e7319a', Repository: 'docker.1ms.run/library/hello-world', Tag: 'latest', Containers: '0' }
  ])
}
