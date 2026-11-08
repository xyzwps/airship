import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { JSX, ReactNode } from 'react'
import { FakeAirship } from './fakeAirship.ts'
import type { AirshipBridge, ShellBridge } from '@airship/contract'

/**
 * 界面挂载器：把应用真渲染到 jsdom 里，然后按"用户看得见的话"来断言与点击。
 *
 * 故意不引第三方测试库，只留这几个动作——册子要的是
 * "读得到哪句话、点下去变成什么"，不是查询选择器：
 *
 *   const m = mountUi(<DagogoApp api={fake.api} />, { fake })
 *   expect(m.text()).toContain('还没有记录。')
 *   await m.type('记一件要做的事，回车添加', '晨跑')
 *   await m.press('添加')
 *   expect(m.text()).toContain('待办 1')
 *
 * React 需要 `IS_REACT_ACT_ENVIRONMENT`；异步链路（应用启动后读设置、探测）
 * 靠 settle() 把微任务与定时器跑干净再断言。
 */

type AnyWindow = typeof globalThis & {
  airship: AirshipBridge
  airshipShell: ShellBridge
  IS_REACT_ACT_ENVIRONMENT: boolean
}

const w = globalThis as unknown as AnyWindow
w.IS_REACT_ACT_ENVIRONMENT = true

export interface MountOptions {
  /** 应用侧契约替身；给了就挂到 window.airship */
  fake?: FakeAirship
  /** 启动器才需要的另一套面，按用例给最小够用的一份 */
  shell?: Partial<ShellBridge>
  /** 应用里的"确定要删吗"式确认框，用例直接给定结果 */
  confirm?: boolean
}

export interface Mount {
  container: HTMLElement
  fake: FakeAirship | null
  /** 整棵树的可见文字 */
  text(): string
  /** 按可见文字找元素（去首尾空白后全等，取最里层那个） */
  byText(label: string): HTMLElement
  allByText(label: string): HTMLElement[]
  /** 有没有这句话（按钮标签、说明文字、错误条都算） */
  has(label: string): boolean
  press(label: string): Promise<void>
  pressIn(selector: string): Promise<void>
  /** 拖到某个区域上还没松手 */
  dragOver(selector: string): Promise<void>
  /** 松手：把这几个文件"拖进"那个区域 */
  dropFiles(selector: string, files: File[]): Promise<void>
  /** 往某个输入框里写字并触发 change（按 placeholder、aria-label 或 id 找） */
  type(where: string, value: string): Promise<void>
  /** 选下拉的一档 */
  select(where: string, value: string): Promise<void>
  /** 按 name 找控件 */
  field(name: string): HTMLElement | null
  key(keyName: string, target?: HTMLElement): Promise<void>
  /** 把异步链路（读设置、探测、队列推进）跑干净 */
  settle(rounds?: number): Promise<void>
  html(): string
  unmount(): void
}

export async function mountUi(node: ReactNode, opts: MountOptions = {}): Promise<Mount> {
  if (opts.fake) w.airship = opts.fake
  // 没给启动器面就得真删掉：应用窗口的 preload 根本不暴露 airshipShell，
  // 留着上一个用例挂上去的那份，"应用里改不了主题"这类用例就会假绿
  if (opts.shell) w.airshipShell = { ...shellStub(), ...opts.shell }
  else delete (w as Partial<{ airshipShell: ShellBridge }>).airshipShell
  if (opts.confirm !== undefined) {
    const answer = opts.confirm
    Object.defineProperty(globalThis, 'confirm', { value: () => answer, configurable: true, writable: true })
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)

  const mount: Mount = {
    container,
    fake: opts.fake ?? null,
    text: () => container.textContent ?? '',
    html: () => container.innerHTML,
    has: (label) => matches(label).length > 0,
    byText: (label) => {
      const hit = matches(label)
      if (hit.length === 0) throw new Error(`界面上读不到「${label}」。当前可见文字：\n${trim(container.textContent ?? '')}`)
      return hit[0]!
    },
    allByText: (label) => matches(label),
    /** 按 CSS 选择器点一颗键：纯图标键没有可见文字，只能这样点 */
    pressIn: async (selector: string) => {
      const el = container.querySelector(selector)
      if (!el) throw new Error(`界面上没有 ${selector}。当前 HTML：\n${trim(container.innerHTML)}`)
      await act(async () => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await mount.settle()
    },
    /**
     * 拖进来时那两下：dragover（还没松手）与 drop（松手）。
     *
     * jsdom 没有 DataTransfer，所以自己造一个只带 files 的挂上去——
     * 用例要验的是"界面收到拖放之后念什么"，不是浏览器怎么递这个事件。
     */
    dragOver: async (selector: string) => {
      const el = container.querySelector(selector)
      if (!el) throw new Error(`界面上没有 ${selector}。当前 HTML：\n${trim(container.innerHTML)}`)
      await act(async () => {
        el.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }))
      })
      await mount.settle()
    },
    dropFiles: async (selector: string, files: File[]) => {
      const el = container.querySelector(selector)
      if (!el) throw new Error(`界面上没有 ${selector}。当前 HTML：\n${trim(container.innerHTML)}`)
      await act(async () => {
        const ev = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperty(ev, 'dataTransfer', { value: { files } })
        el.dispatchEvent(ev)
      })
      await mount.settle()
    },
    press: async (label) => {
      const el = mount.byText(label)
      await act(async () => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      })
      await mount.settle()
    },
    type: async (where, value) => {
      const el = findField(where)
      await act(async () => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    select: async (where, value) => {
      const el = findField(where)
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
        setter?.call(el, value)
        el.dispatchEvent(new Event('change', { bubbles: true }))
      })
      await mount.settle()
    },
    field: (name) => {
      const byId = container.querySelector(`[data-test="${name}"]`)
      if (byId) return byId as HTMLElement
      return container.querySelector(`[aria-label="${name}"]`) as HTMLElement | null
    },
    key: async (keyName, target) => {
      const el = target ?? (container.querySelector('input') ?? container)
      await act(async () => {
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: keyName, code: keyName, bubbles: true, cancelable: true })
        )
      })
      await mount.settle()
    },
    settle: async (rounds = 6) => {
      for (let i = 0; i < rounds; i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0))
        })
      }
    },
    unmount: () => {
      root?.unmount()
      root = null
      container.remove()
    }
  }

  /** 找元素：全等优先，其次包含；同一句话命中多处时取最里层 */
  function matches(label: string): HTMLElement[] {
    const wanted = label.trim()
    const all = Array.from(container.querySelectorAll<HTMLElement>('*'))
    const exact = all.filter((el) => visibleText(el) === wanted)
    if (exact.length > 0) return deepestFirst(exact)
    const partial = all.filter((el) => visibleText(el).includes(wanted))
    return deepestFirst(partial)
  }

  function visibleText(el: HTMLElement): string {
    // 只算这个节点自己的文字（子节点的重复文本会干扰全等判定）
    return Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim()
  }

  function deepestFirst(list: HTMLElement[]): HTMLElement[] {
    return list
      .filter((el) => !list.some((other) => other !== el && el.contains(other)))
      .concat(list.filter((el) => list.some((other) => other !== el && el.contains(other))))
  }

  function findField(where: string): HTMLElement {
    const el =
      container.querySelector<HTMLElement>(`[placeholder="${where}"]`) ??
      container.querySelector<HTMLElement>(`[aria-label="${where}"]`) ??
      container.querySelector<HTMLElement>(`#${where}`)
    if (!el) throw new Error(`找不到输入控件「${where}」。当前 HTML：\n${trim(container.innerHTML)}`)
    return el
  }

  void (node as JSX.Element)
  // 初次渲染走一趟 async act：effects 里发出的 promise 链在这一趟里冲完，
  // 后面的状态更新就不会落到 act 之外（React 会为此报警）
  await act(async () => {
    root?.render(node)
  })
  // effects 里的 promise（读主题、读设置）落在下一趟 act 里，不留 act 警告
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }

  return mount
}

function trim(s: string, max = 600): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 启动器面的空壳：用例只覆盖自己需要的那几颗方法 */
function shellStub(): ShellBridge {
  const no = async (): Promise<never> => {
    throw new Error('这个用例没装配启动器面的这个方法')
  }
  return {
    apps: no,
    openApp: no,
    inspectPackage: no,
    installPackage: no,
    uninstallPackage: no,
    openApps: no,
    setTheme: no,
    theme: no,
    settings: { get: no, set: no },
    rootPaths: no,
    shellInfo: no,
    currentPlatform: no,
    toolPath: no,
    setToolPath: no,
    grants: no,
    openExternal: no,
    metrics: no,
    window: { minimize: no, toggleMaximize: no, close: no, isMaximized: no, setTitle: no },
    on: () => () => undefined
  }
}
