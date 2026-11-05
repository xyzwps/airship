// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { FakeAirship, type StartCall, type StreamCtl } from '@tests/helpers/fakeAirship'
import { mountUi, type Mount } from '@tests/helpers/mount'
import VcpApp from '@apps/vcp/VcpApp'
import type { AppApi, ShellEventListener } from '@shared/protocol'

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
      return { stderr: opts.stderr ?? PROBE_STDERR }
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

/** 处理链上那一排开关：顺序就是界面上的顺序 */
async function pressToggle(m: Mount, index: number): Promise<void> {
  const el = m.container.querySelectorAll<HTMLButtonElement>('.vcp__toggle')[index]
  if (!el) throw new Error(`处理链上没有第 ${index + 1} 个开关`)
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

const command = (m: Mount): string => (m.container.querySelector('.vcp__cmd') as HTMLElement).textContent ?? ''

/** 按"这一格里有哪个选项"找到那一下拉，选一项 */
async function chooseBy(m: Mount, oneOf: string, value: string): Promise<void> {
  const select = [...m.container.querySelectorAll('select')].find((el) =>
    [...el.querySelectorAll('option')].some((o) => o.textContent === oneOf)
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
    expect(command(m)).toContain('-vf scale=w=1920:h=-2')
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
    expect(fake.clipboard).toBe(cmd)
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
