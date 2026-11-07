// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { FakeAirship, type StartCall, type StreamCtl } from '@airship/sdk/testing'
import { mountUi, type Mount } from '@airship/sdk/testing'
import VcpApp from '../VcpApp'
import { placeCard } from '../HelpTip'
import { ACODECS, HELP, VCODECS, type HelpKey } from '../help'
import type { AppApi, ShellEventListener } from '@airship/contract'

/**
 * VC 册子（src/apps/vcp/specs/vcp.md）里"界面看得见什么"那几条：真挂载、真点、真喂输出流。
 * ffmpeg 由 FakeAirship 的 proc 替身顶上：命令行记在 procCalls，流式输出由用例往里推。
 *
 * FakeAirship.api 是展开装配的，展开只带自有属性；paths / theme / on 这三个原型方法
 * 要补回去，应用拿到的才是完整的一张面。
 */
function appApi(fake: FakeAirship): AppApi {
  return Object.assign(fake.api, {
    paths: () => fake.paths(),
    theme: () => fake.theme(),
    on: (fn: ShellEventListener) => fake.on(fn)
  })
}

const CAPS = ['fs.read', 'fs.write', 'dialog', 'settings', 'proc', 'notify', 'clipboard', 'log'] as const
const FFMPEG = 'T:/ffmpeg.exe'
const SOURCE = 'T:/media/4k_demo.mkv'
const OUT = 'T:/media/4k_demo.mp4'

const PROBE_STDERR = `Input #0, matroska,webm, from 'T:/media/4k_demo.mkv':
  Duration: 00:01:40.00, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0: Video: hevc (Main), yuv420p(tv), 3840x2160, 25 fps, 25 tbr, 1k tbn
  Stream #0:1(chi): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)
  Stream #0:2(eng): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s
  Stream #0:3(chi): Subtitle: subrip
  Stream #0:4: Video: mjpeg, 254x254 [SPC], 0 fps (attached pic)
  Stream #0:5(eng): Subtitle: hdmv_pgs_subtitle
`

interface Options {
  picks?: Array<string[] | string | null>
  ffmpeg?: string | null
  stderr?: string
  /** 按探测的路径给不同的 ffmpeg 输出：一份界面里换源才验得出档位回落 */
  stderrFor?: Record<string, string>
  files?: Record<string, string>
}

function rig(opts: Options = {}): { fake: FakeAirship; api: AppApi; calls: string[][]; jobs: Map<string, StreamCtl> } {
  const jobs = new Map<string, StreamCtl>()
  const calls: string[][] = []
  const fake = new FakeAirship({
    id: 'vcp',
    capabilities: [...CAPS],
    tools: ['ffmpeg'],
    toolPaths: { ffmpeg: 'ffmpeg' in opts ? (opts.ffmpeg ?? null) : FFMPEG },
    picks: opts.picks ?? [[SOURCE]],
    files: { [SOURCE]: 'k'.repeat(2 * 1048576), ...(opts.files ?? {}) },
    run: (_exe, args) => {
      calls.push(args)
      // 探测以外的调用（抽字幕、写文件）都是干净退出
      if (args.includes('-f') || args.includes('-y')) return { code: 0, stdout: '', stderr: '' }
      const byPath = opts.stderrFor?.[args[args.length - 1] ?? '']
      return { stderr: byPath ?? opts.stderr ?? PROBE_STDERR }
    },
    start: (call, ctl) => {
      jobs.set(call.jobId, ctl)
    }
  })
  return { fake, api: appApi(fake), calls, jobs }
}

async function mount(api: AppApi, fake: FakeAirship): Promise<Mount> {
  return mountUi(<VcpApp api={api} />, { fake })
}

async function openVideo(m: Mount): Promise<void> {
  await m.press('打开视频')
  await m.settle(12)
}

/** 处理链上那一排开关：顺序就是界面上的顺序（缩放是第 0 颗） */
async function pressToggle(m: Mount, index: number): Promise<void> {
  const el = m.container.querySelectorAll<HTMLButtonElement>('.vcp__toggle')[index]
  if (!el) throw new Error(`处理链上没有第 ${index + 1} 个开关`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await m.settle()
}

/** 缩放的两颗档位键 */
const levelKey = (m: Mount, p: 1080 | 2160): HTMLButtonElement =>
  m.container.querySelector<HTMLButtonElement>(`[data-test="缩放档位-${p}"]`)!

async function pickLevel(m: Mount, p: 1080 | 2160): Promise<void> {
  const el = levelKey(m, p)
  if (!el) throw new Error(`界面上没有 ${p}p 那颗档位键`)
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await m.settle()
}

/** 选流区的一颗勾选框/单选钮：按它旁边那句念得出什么来点 */
async function pickStream(m: Mount, reads: string): Promise<void> {
  const label = [...m.container.querySelectorAll('label.vcp__pick')].find((l) => (l.textContent ?? '').includes(reads))
  const input = label?.querySelector('input')
  if (!input) throw new Error(`选流区读不到「${reads}」`)
  await act(async () => {
    ;(input as HTMLInputElement).click()
  })
  await m.settle()
}

async function setPath(m: Mount, value: string): Promise<void> {
  const el = m.container.querySelector<HTMLInputElement>('.vcp__path')
  if (!el) throw new Error('界面上没有输出路径那一栏')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await m.settle()
}

/** 指针事件：React 的 onMouseEnter/onMouseLeave 是从 mouseover/mouseout 合成的 */
async function fireMouse(m: Mount, el: Element, type: 'mouseover' | 'mouseout'): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }))
  })
  await m.settle()
}

function helpBtn(m: Mount, k: string): Element {
  const el = m.container.querySelector(`.vcp__help[data-help="${k}"]`)
  if (!el) throw new Error(`界面上没有「${k}」旁边那颗 ?`)
  return el
}

async function hoverHelp(m: Mount, k: string): Promise<void> {
  await fireMouse(m, helpBtn(m, k), 'mouseover')
}

async function unhoverHelp(m: Mount, k: string): Promise<void> {
  await fireMouse(m, helpBtn(m, k), 'mouseout')
}

const helpCard = (m: Mount, k: string): HTMLElement | null =>
  m.container.querySelector(`.vcp__help-card[data-help="${k}"]`)

/** 卡片不是立刻收的：问号与卡片之间留了一拍缓冲，断言"收了"要先等过那一拍 */
async function pastGrace(m: Mount): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 240))
  })
  await m.settle()
}

const command = (m: Mount): string => (m.container.querySelector('.vcp__cmd') as HTMLElement).textContent ?? ''

/** 按"这一格里有哪个选项"找到那一下拉，选一项：给可见文字或给选项的值都算 */
async function chooseBy(m: Mount, oneOf: string, value: string): Promise<void> {
  const select = [...m.container.querySelectorAll('select')].find((el) =>
    [...el.querySelectorAll('option')].some((o) => o.value === oneOf || o.textContent === oneOf)
  ) as HTMLSelectElement | undefined
  if (!select) throw new Error(`界面上找不到含「${oneOf}」的下拉`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await m.settle()
}

describe('打开一个文件，界面念得出 ffmpeg 说的话', () => {
  it('VC-001 探测就问 ffmpeg 一句话：-hide_banner -i <文件>', async () => {
    const { fake, api, calls } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect(calls[0]).toEqual(['-hide_banner', '-i', SOURCE])
    expect(fake.procCalls[0]!.exe).toBe(FFMPEG)
    m.unmount()
  })

  it('VC-002 顶栏念得出时长、格式、码率、大小与流数', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect(m.text()).toContain('4k_demo.mkv')
    expect(m.text()).toContain('00:01:40.00')
    expect(m.text()).toContain('5000 kb/s')
    expect(m.text()).toContain('2.0 MB')
    expect(m.text()).toContain('6 条流')
    expect(m.has('还没打开视频')).toBe(false)
    m.unmount()
  })

  it('VC-008 选流列表里认得出封面流与图形字幕', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect(m.text()).toContain('（封面）')
    expect(m.text()).toContain('（图形）')
    expect(m.text()).toContain('v:0 hevc 3840x2160 25fps')
    m.unmount()
  })

  it('VC-051 打开视频后输出路径自动落在源文件同目录', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect((m.container.querySelector('.vcp__path') as HTMLInputElement).value).toBe(OUT)
    m.unmount()
  })

  it('VC-074 输出名跟着配置走：缩放那一截自己长收，后缀永远跟着容器换', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    const field = (): string => (m.container.querySelector('.vcp__path') as HTMLInputElement).value

    // 打开缩放（默认落在 1080p）→ 名字里那一截自己长出来
    await pressToggle(m, 0)
    expect(field()).toBe('T:/media/4k_demo_1080p.mp4')

    // 换到 2160p → 那一截跟着换；关掉缩放 → 那一截自己收回去
    await pickLevel(m, 2160)
    expect(field()).toBe('T:/media/4k_demo_2160p.mp4')
    await pressToggle(m, 0)
    expect(field()).toBe(OUT)

    // 换容器 → 后缀跟着换
    await chooseBy(m, 'mp4', 'mkv')
    expect(field()).toBe('T:/media/4k_demo.mkv')

    // 手敲过之后主名不再被覆盖，但换容器时后缀照样跟着换
    await setPath(m, 'T:/media/我起的名字.mkv')
    await pressToggle(m, 0)
    expect(field()).toBe('T:/media/我起的名字.mkv')
    await chooseBy(m, 'mkv', 'mp4')
    expect(field()).toBe('T:/media/我起的名字.mp4')
    m.unmount()
  })

  it('VC-075 手敲的后缀与容器不符：检查区念出来，一键「换成 .mp4」点得动', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await setPath(m, 'T:/media/4k_demo.avi')

    expect(m.text()).toContain('输出名后缀是 .avi，容器选的却是 mp4：ffmpeg 按后缀认容器，产物会是 .avi。')
    await m.press('换成 .mp4')
    expect((m.container.querySelector('.vcp__path') as HTMLInputElement).value).toBe('T:/media/4k_demo.mp4')
    expect(m.text()).not.toContain('输出名后缀是 .avi')
    m.unmount()
  })

  it('VC-052 什么视频都没打开时界面说的话', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    expect(m.text()).toContain('还没打开视频')
    expect(m.text()).toContain('打开视频后在这里选视频 / 音频 / 字幕轨。')
    expect(m.text()).toContain('还没有打开视频。')
    expect(m.byText('批量套用').disabled).toBe(true)
    expect(m.byText('提交任务').disabled).toBe(true)
    expect(m.text()).toContain('队列是空的。')
    expect(m.text()).toContain('队列空')
    m.unmount()
  })

  it('VC-069 ffmpeg 不可用时顶栏那枚与硬开视频的原因', async () => {
    const { fake, api } = rig({ ffmpeg: null })
    const m = await mount(api, fake)
    expect(m.text()).toContain('ffmpeg 不可用')

    await openVideo(m)
    expect(m.text()).toContain('没找到 ffmpeg')
    expect(m.text()).not.toContain('Error invoking remote method')
    m.unmount()
  })
})

describe('命令、检查与修正都在同一屏上', () => {
  it('VC-063 命令那一行就是将要执行的参数，随界面改动走', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect(command(m)).toContain(`ffmpeg -y -i ${SOURCE}`)
    expect(command(m)).toContain('-map 0:v:0')
    expect(command(m)).toContain(OUT)

    await pressToggle(m, 0)
    expect(command(m)).toContain('-vf scale=-2:1080')
    m.unmount()
  })

  it('VC-064 检查里有 error 时提交点不动，改回能保留的流就能提交', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    await pickStream(m, '不要视频')
    await pickStream(m, 'a:0')
    expect(m.text()).toContain('一条流都没保留，输出会是空文件。')
    expect(m.byText('提交任务').disabled).toBe(true)

    await pickStream(m, 'a:0')
    expect(m.byText('提交任务').disabled).toBe(false)
    m.unmount()
  })

  it('VC-062 一键修正在界面上点得动：画面选了复制时那句改完命令跟着变', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await pressToggle(m, 0)
    await chooseBy(m, 'libsvtav1', 'copy')

    expect(command(m)).toContain('-c:v copy')
    expect(m.text()).toContain('视频不能选“直接复制”')
    await m.press('改用 x264')
    expect(command(m)).toContain('-c:v libx264')
    expect(m.text()).not.toContain('视频不能选“直接复制”')
    m.unmount()
  })

  it('VC-068 复制命令：剪贴板里是那一行，按钮改口说"已复制"', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    const cmd = command(m)

    await m.press('复制命令')
    expect(fake.clipboardText).toBe(cmd)
    expect(m.text()).toContain('已复制')
    m.unmount()
  })
})

describe('提交任务与右栏队列', () => {
  it('VC-065 提交后右栏出现 #1，壳收到的命令行带着进度管道', async () => {
    const { fake, api, jobs } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')

    const call = fake.procCalls.find((c) => c.jobId)
    expect(call?.args.slice(0, 4)).toEqual(['-hide_banner', '-nostats', '-progress', 'pipe:1'])
    expect(call?.args).toContain('-i')
    expect(call!.args[call!.args.length - 1]).toBe(OUT)
    expect(m.text()).toContain('#1')
    expect(m.text()).toContain('4k_demo.mkv')
    expect(jobs.size).toBe(1)
    m.unmount()
  })

  it('VC-066 进行中：状态与速度念得出壳推来的那一截', async () => {
    const { fake, api, jobs } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')
    const ctl = [...jobs.values()][0]!

    await act(async () => {
      ctl.chunk('stdout', 'out_time=00:00:50.000000\nspeed=2.35x\n')
    })
    await m.settle()
    expect(m.text()).toContain('进行中 50%')
    expect(m.text()).toContain('2.35x')
    expect(m.text()).toContain('已用')
    expect(m.has('停止')).toBe(true)
    m.unmount()
  })

  it('VC-067 跑完：状态念得出"已完成"与实际写出来的大小', async () => {
    const { fake, api, jobs } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')
    const ctl = [...jobs.values()][0]!
    fake.seed(OUT, 'y'.repeat(2 * 1048576 + 100))

    await act(async () => {
      ctl.chunk('stdout', 'progress=end\n')
      ctl.exit({ code: 0 })
    })
    await m.settle(12)
    expect(m.text()).toContain('已完成 2.0 MB')
    expect(m.text()).toContain('完成 1')
    expect(m.byText('移除')).toBeTruthy()
    m.unmount()
  })

  it('VC-070 跑砸了：状态念"失败"，第二行念最后一句报错', async () => {
    const { fake, api, jobs } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')
    const ctl = [...jobs.values()][0]!

    await act(async () => {
      ctl.chunk('stderr', 'frame= 0\n[libx264] error: 写不进去\n')
      ctl.exit({ code: 1 })
    })
    await m.settle(12)
    expect(m.text()).toContain('失败')
    expect(m.text()).toContain('error: 写不进去')
    expect(m.text()).toContain('失败 1')
    m.unmount()
  })

  it('VC-071 全部停止：在跑的念"已停止"，排队的念"已取消"', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')
    await setPath(m, 'T:/media/第二条.mp4')
    await m.press('提交任务')

    expect(m.text()).toContain('进行中 1 · 排队 1')
    await m.press('全部停止')
    expect(m.text()).toContain('已停止')
    expect(m.text()).toContain('已取消')
    m.unmount()
  })

  it('VC-073 两条任务排队时汇总分项念得出来，跑着的那条不被"清掉完成"带走', async () => {
    const { fake, api, jobs } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('提交任务')
    await setPath(m, 'T:/media/第二条.mp4')
    await m.press('提交任务')
    expect(m.text()).toContain('进行中 1 · 排队 1')

    await m.press('清掉完成')
    expect(m.text()).toContain('进行中 1 · 排队 1')

    const ctl = [...jobs.values()][0]!
    fake.seed(OUT, 'y'.repeat(1048576))
    await act(async () => {
      ctl.exit({ code: 0 })
    })
    await m.settle(12)
    // 串行队列：跑完一条自动接上排着的那条，所以这里是"在跑 + 完成"两笔
    expect(m.text()).toContain('进行中 1 · 完成 1')
    m.unmount()
  })

  it('VC-072 批量套用：两个文件各成一条，撞名的自动改名并写在说明里', async () => {
    // 两次对话框：打开视频挑一个，批量套用挑两个（同名输出要自动改名）
    const { fake, api } = rig({ picks: [[SOURCE], [SOURCE, 'T:/media/4k_demo.mp4']] })
    fake.vol.set('T:/media/4k_demo.mp4', 'k'.repeat(1 << 20))
    const m = await mount(api, fake)
    await openVideo(m)
    await m.press('批量套用')

    expect(m.text()).toContain('#1')
    expect(m.text()).toContain('#2')
    expect(m.text()).toContain('4k_demo_2.mp4')
    expect(m.text()).toContain('改名 4k_demo_2.mp4')
    m.unmount()
  })
})

describe('参数旁边那颗 ?：悬停念出作用与代价', () => {
  it('VC-076 悬停 ? 出说明卡：作用与代价两句都念得出来', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    expect(helpCard(m, 'scale')).toBeNull()
    await hoverHelp(m, 'scale')
    const card = helpCard(m, 'scale')
    expect(card?.textContent).toContain('缩放')
    expect(card?.textContent).toContain('在两档里挑一个：1080p 或 2160p')
    expect(card?.textContent).toContain('折档必须重编码')
    m.unmount()
  })

  it('VC-077 纯图标键：无障碍名称带参数名，键盘聚焦同样出卡、失焦就收', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)
    const btn = m.container.querySelector('.vcp__help[data-help="crf"]') as HTMLElement

    expect(btn.getAttribute('aria-label')).toBe('说明：质量 / 速度')
    await act(async () => {
      btn.focus()
    })
    await m.settle()
    expect(helpCard(m, 'crf')).toBeTruthy()

    await act(async () => {
      btn.blur()
    })
    await pastGrace(m)
    expect(helpCard(m, 'crf')).toBeNull()
    m.unmount()
  })

  it('VC-080 问号与卡片是同一块热区：指针挪到卡片上不收，两边都离开才收', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    await hoverHelp(m, 'scale')
    const card = helpCard(m, 'scale') as HTMLElement
    expect(card).toBeTruthy()

    // 指针离开问号，那一拍之内落到卡片上：卡片留下，还是同一张
    await fireMouse(m, helpBtn(m, 'scale'), 'mouseout')
    await fireMouse(m, card, 'mouseover')
    await pastGrace(m)
    expect(helpCard(m, 'scale')).toBe(card)

    // 两边都离开、隔了一拍没再接住：这才收
    await fireMouse(m, card, 'mouseout')
    await pastGrace(m)
    expect(helpCard(m, 'scale')).toBeNull()
    m.unmount()
  })

  it('VC-078 说不清的三处各带一段小动画，缩放那张只有两句文字', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    for (const k of ['crf', 'faststart', 'pixfmt']) {
      await hoverHelp(m, k)
      expect(helpCard(m, k)?.querySelector('.vcp__demo')).toBeTruthy()
      await unhoverHelp(m, k)
    }

    await hoverHelp(m, 'scale')
    expect(helpCard(m, 'scale')?.querySelector('.vcp__demo')).toBeNull()
    m.unmount()
  })

  it('VC-079 每一个参数旁边都有一颗 ?：界面上的 ? 与文案表一处不差，两句都念得出话', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    const keys = Object.keys(HELP) as HelpKey[]
    const onScreen = [...m.container.querySelectorAll<HTMLElement>('.vcp__help')].map((b) => b.dataset.help)
    expect(onScreen.slice().sort()).toEqual(keys.slice().sort())

    let withDemo = 0
    for (const k of keys) {
      await hoverHelp(m, k)
      const card = helpCard(m, k)
      expect(card, `悬停「${k}」旁边那颗 ? 没出卡片`).toBeTruthy()
      expect(card?.textContent).toContain('作用')
      expect(card?.textContent).toContain('代价')
      // 两句都得真说出话，不留空着的格子
      expect(HELP[k].what.length).toBeGreaterThan(12)
      expect(HELP[k].cost.length).toBeGreaterThan(12)
      if (card?.querySelector('.vcp__demo')) withDemo += 1
      await unhoverHelp(m, k)
    }
    expect(withDemo).toBe(3)
    m.unmount()
  })
})

describe('说明卡摆在哪、箭头指着谁', () => {
  const VIEW = { w: 1100, h: 740 }
  const SIZE = { w: 320, h: 200 }
  const at = (top: number, left = 300): { left: number; top: number; bottom: number; width: number } => ({
    left,
    top,
    bottom: top + 16,
    width: 16
  })

  it('VC-081 下面放不下就翻到上面，箭头跟着从卡片上边挪到下边', () => {
    const room = placeCard(at(100), SIZE, VIEW)
    expect(room.side).toBe('below')
    expect(room.top).toBe(124) // 问号下沿 116 + 8
    expect(room.caretX).toBe(160) // 卡片正好以问号为中心：尖落在卡片正中

    const tight = placeCard(at(600), SIZE, VIEW)
    expect(tight.side).toBe('above')
    expect(tight.top).toBe(392) // 600 - 8 - 200
  })

  it('VC-081 卡片被视口边界夹住挪了位子，箭头仍找回问号那一列', () => {
    const atEdge = placeCard(at(100, 8), SIZE, VIEW)
    expect(atEdge.left).toBe(8) // 本想以问号为中心（-144），被夹到边上
    expect(atEdge.caretX).toBe(14) // 尖贴到最小距离，仍旧朝着问号那边
  })
})

/** 只有一张 854×480 视频轨的探测输出，用来验"源比档位小" */
const STD_480 = `Input #0, matroska,webm, from 'T:/media/4k_demo.mkv':
  Duration: 00:01:40.00, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p(tv), 854x480, 25 fps, 25 tbr, 1k tbn
  Stream #0:1(chi): Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)
`

/** 源高正好 1080：2160p 那一档是放大 */
const STD_1080 = STD_480.replace('854x480', '1920x1080')

describe('处理链：关着的行不摆后面的控件，缩放只有两档', () => {
  /** 处理链那一格：数输入框只数这一格里的 */
  function chain(m: Mount): HTMLElement {
    const card = [...m.container.querySelectorAll('section.card')].find((c) =>
      (c.querySelector('.card__title')?.textContent ?? '').includes('处理链')
    )
    if (!card) throw new Error('界面上没有处理链那一格')
    return card as HTMLElement
  }

  const nums = (m: Mount): number => chain(m).querySelectorAll('.vcp__num').length

  it('VC-082 开关关着时那一行只剩开关，打开后后面的控件才出现', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    // 八行全关着：处理链里一个输入框都没有，连说明文字都不出现
    // （只数这一格：编码项的说明里也带「倍」这种字，整页去比会误判）
    expect(nums(m)).toBe(0)
    expect(chain(m).querySelectorAll('.vcp__time').length).toBe(0)
    expect(chain(m).textContent ?? '').not.toContain('快速定位')
    expect(chain(m).textContent ?? '').not.toContain('倍')

    // 第二颗开关是补边（缩放占第 0 颗）：打开才有那两个数
    await pressToggle(m, 1)
    expect(nums(m)).toBe(2)
    await pressToggle(m, 1)
    expect(nums(m)).toBe(0)
    m.unmount()
  })

  it('VC-083 缩放有开关：打开后两档键才出现，选一档，选中那档亮着', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    // 关着时两档键都不出现——跟其余七行同一个规矩
    expect(levelKey(m, 1080)).toBeFalsy()
    expect(command(m)).not.toContain('scale=')

    await pressToggle(m, 0)
    expect(levelKey(m, 1080).className).toContain('vcp__level--on')
    expect(command(m)).toContain('-vf scale=-2:1080')

    await pickLevel(m, 2160)
    expect(levelKey(m, 2160).className).toContain('vcp__level--on')
    expect(levelKey(m, 1080).className).not.toContain('vcp__level--on')
    expect(command(m)).toContain('-vf scale=-2:2160')

    await pressToggle(m, 0)
    expect(command(m)).not.toContain('scale=')
    expect(levelKey(m, 1080)).toBeFalsy()
    m.unmount()
  })

  it('VC-084 两档都比源高时开关自己灰掉并念出原因；只有一档比源高时那一档灰掉', async () => {
    // 480 的源：整条无处可用，灰的是开关，两颗档位键根本不出现
    const a = rig({ stderr: STD_480 })
    const m = await mount(a.api, a.fake)
    await openVideo(m)
    const sw = m.container.querySelectorAll<HTMLButtonElement>('.vcp__toggle')[0] as HTMLButtonElement
    expect(sw.disabled).toBe(true)
    expect(sw.getAttribute('aria-label')).toBe('源高 480，1080p 与 2160p 都是放大，不给选')
    expect(levelKey(m, 1080)).toBeFalsy()
    m.unmount()

    // 1080 的源：开关能开，开起来只有 1080p 能选，2160p 灰着说清原因
    const b = rig({ stderr: STD_1080 })
    const m2 = await mount(b.api, b.fake)
    await openVideo(m2)
    expect((m2.container.querySelectorAll('.vcp__toggle')[0] as HTMLButtonElement).disabled).toBe(false)
    await pressToggle(m2, 0)
    expect(levelKey(m2, 1080).disabled).toBe(false)
    expect(levelKey(m2, 2160).disabled).toBe(true)
    expect(levelKey(m2, 2160).getAttribute('aria-label')).toBe('2160p 大于源高 1080，是放大，不给选')
    m2.unmount()

    // 开着 2160p 换到 1080 的源：档位自己落到 1080p，名字跟着改
    const SMALL = 'T:/media/小片.mp4'
    const c = rig({ picks: [[SOURCE], [SMALL]], stderrFor: { [SMALL]: STD_1080 }, files: { [SMALL]: 'k'.repeat(1048576) } })
    const m3 = await mount(c.api, c.fake)
    await openVideo(m3)
    await pressToggle(m3, 0)
    await pickLevel(m3, 2160)
    expect((m3.container.querySelector('.vcp__path') as HTMLInputElement).value).toBe('T:/media/4k_demo_2160p.mp4')
    await openVideo(m3)
    expect(levelKey(m3, 2160).disabled).toBe(true)
    expect((m3.container.querySelector('.vcp__path') as HTMLInputElement).value).toBe('T:/media/小片_1080p.mp4')
    m3.unmount()
  })
})

describe('编码选项都自带"怎么选"', () => {
  const selectWith = (m: Mount, oneValue: string): HTMLSelectElement =>
    [...m.container.querySelectorAll('select')].find((el) =>
      [...el.querySelectorAll('option')].some((o) => o.value === oneValue)
    ) as HTMLSelectElement

  /** 一份选项表对着界面念一遍：每项都是"编码名 · 取舍"，一项不落、一字不差 */
  function checkNotes(m: Mount, oneValue: string, list: Array<{ v: string; note: string }>): void {
    expect([...selectWith(m, oneValue).options].map((o) => o.textContent ?? '')).toEqual(
      list.map((c) => `${c.v} · ${c.note}`)
    )
  }

  it('VC-085 视频与音频编码的每一项后面都跟着这一项的取舍，选中那项在框里也念得出', async () => {
    const { fake, api } = rig()
    const m = await mount(api, fake)
    await openVideo(m)

    checkNotes(m, 'hevc_nvenc', VCODECS)
    checkNotes(m, 'libopus', ACODECS)

    // 选中那一项在框里也带着这一截念出来
    await chooseBy(m, 'copy', 'copy')
    const v = selectWith(m, 'hevc_nvenc')
    expect(v.value).toBe('copy')
    expect(v.selectedOptions[0]?.textContent).toContain('不重编码原样搬')

    await chooseBy(m, 'libopus', 'libopus')
    const a = selectWith(m, 'libopus')
    expect(a.value).toBe('libopus')
    expect(a.selectedOptions[0]?.textContent).toContain('老设备与 mp4 不太认')
    m.unmount()
  })
})
