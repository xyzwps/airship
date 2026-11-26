// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import {
  commands,
  imagesNdjson,
  makeFake,
  mountWsld,
  tap,
  unmountAll
} from './support'
import type { Mount } from '@airship/sdk/testing'
import type { FakeAirship, StartCall, StreamCtl } from '@airship/sdk/testing'
import { imageReference, imageIsTagged } from '../model'
import { parseImages } from '../parse'
import { tokenize } from '../run'

/**
 * RB 册子里界面那一半：编排页的表单、复制/读回、就地执行与历史。
 *
 * 命令行看 `fake.procCalls`，话看界面文字；拼装与解析的纯逻辑判据在 run-args.test.tsx 那条腿。
 */

const CID = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

interface Held {
  call: StartCall
  ctl: StreamCtl
}

function stage(setup: { wslc?: string | null } = {}) {
  const held: Held[] = []
  const fake = makeFake({
    wslc: setup.wslc,
    run: (_exe, args) => {
      if (args[0] === 'images') return { stdout: imagesNdjson() }
      return { stdout: '' }
    },
    start: (call, ctl) => {
      held.push({ call, ctl })
    }
  })
  return { fake, held }
}

/** 打开应用并停在「命令编排」页 */
async function openRun(fake: FakeAirship): Promise<Mount> {
  const m = await mountWsld(fake)
  await m.settle()
  await tap(m, '页签-命令编排')
  await m.settle()
  return m
}

const cmdLine = (m: Mount): string => (m.field('编排-命令') as HTMLElement).textContent ?? ''

const value = (m: Mount, name: string): string => (m.field(name) as HTMLInputElement).value

const isDisabled = (m: Mount, name: string): boolean => (m.field(name) as HTMLButtonElement).disabled

/** 多行同标签时按序号点第二格：findField 只认第一颗，行号判据得自己拿 */
async function typeAt(m: Mount, ariaLabel: string, index: number, text: string): Promise<void> {
  const el = m.container.querySelectorAll<HTMLInputElement>(`[aria-label="${ariaLabel}"]`)[index]
  if (!el) throw new Error(`界面上没有第 ${index + 1} 格「${ariaLabel}」`)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await m.settle()
}

/** 同标签的第 n 格（行号判据要能指着具体那一行说话） */
function valueAt(m: Mount, ariaLabel: string, index: number): string {
  const el = m.container.querySelectorAll<HTMLInputElement>(`[aria-label="${ariaLabel}"]`)[index]
  if (!el) throw new Error(`界面上没有第 ${index + 1} 格「${ariaLabel}」`)
  return el.value
}

const rowsOf = (m: Mount, ariaLabel: string): number =>
  m.container.querySelectorAll(`[aria-label="${ariaLabel}"]`).length

afterEach(() => unmountAll())

describe('命令边填边长', () => {
  it('RB-001 进页面第一眼就有一条命令', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    expect(cmdLine(m)).toBe('wslc run -d')
    expect((m.field('编排-后台') as HTMLInputElement).checked).toBe(true)
  })

  it('RB-002 改哪个字段，命令就动哪一段', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    expect(cmdLine(m)).toBe('wslc run -d nginx')
    await tap(m, '编排-后台')
    expect(cmdLine(m)).toBe('wslc run nginx')
    await m.type('容器名称 (--name)', 'web')
    expect(cmdLine(m)).toBe('wslc run --name web nginx')
  })

  it('RB-003 显示的一条与交给 wslc 的一条逐段一致', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await m.type('容器名称 (--name)', 'my web')
    await tap(m, '编排-复制')
    expect(fake.clipboardText).toBe(cmdLine(m))
    await tap(m, '编排-执行')
    const displayed = tokenize(cmdLine(m))
    expect(['wslc', ...held[0]!.call.args]).toEqual(displayed)
  })

  it('RB-050 长尾选项原样透传、不校验，排在镜像之前', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await m.type('其他参数（原样追加）', '--mount type=bind,source=/x,target=/y --cidfile /tmp/id')
    expect(m.field('编排-问题')).toBeNull()
    const line = cmdLine(m)
    expect(line).toContain('--mount type=bind,source=/x,target=/y --cidfile /tmp/id')
    expect(line.indexOf('--cidfile')).toBeLessThan(line.indexOf('nginx'))
  })
})

describe('校验闸门', () => {
  it('RB-008 镜像为空时复制键直接灰掉', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    expect(m.text()).toContain('还差这些就能执行：')
    expect(m.text()).toContain('镜像不能为空 —— 至少要指定一个镜像。')
    expect(isDisabled(m, '编排-复制')).toBe(true)
    expect(isDisabled(m, '编排-执行')).toBe(true)
  })

  it('RB-009 多个问题一次列全，各带行号', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-加端口')
    await m.type('主机端口', '8080') // 只欠容器端口：整行全空视同没有这行，报不出行号
    await tap(m, '编排-加变量')
    await tap(m, '编排-加变量')
    await typeAt(m, '变量名', 1, 'A=B')
    expect(m.text()).toContain('端口第 1 行：容器端口不能为空。')
    expect(m.text()).toContain('环境变量第 2 行：变量名不能为空，也不能带 = 号。')
    const block = m.field('编排-问题') as HTMLElement
    expect(block.textContent).toContain('还差这些就能执行：')
  })

  it('RB-010 问题修完，放行跟着回来', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-加端口')
    await m.type('主机端口', '8080')
    expect(isDisabled(m, '编排-复制')).toBe(true)
    await m.type('容器端口', '80')
    expect(m.field('编排-问题')).toBeNull()
    expect(isDisabled(m, '编排-复制')).toBe(false)
    expect(isDisabled(m, '编排-执行')).toBe(false)
  })

  it('RB-011 不像端口的值，原样回显在提示里', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-加端口')
    await m.type('容器端口', 'abc')
    expect(m.text()).toContain('端口第 1 行：abc 不像端口（可用 8080 或 8000-8010）。')
  })
})

describe('就地执行', () => {
  it('RB-020 后台执行拿到容器 ID', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'hello-world')
    await tap(m, '编排-执行')
    expect(held[0]!.call.args).toEqual(['run', '-d', 'hello-world'])
    held[0]!.ctl.chunk('stdout', `${CID}\n`)
    held[0]!.ctl.exit()
    await m.settle()
    expect(m.text()).toContain(CID)
    expect(m.text()).toContain(`已运行容器 ${CID}，可到「容器」页查看。`)
  })

  it('RB-021 取消勾选后台，容器输出逐行实时落框', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-后台')
    await tap(m, '编排-执行')
    held[0]!.ctl.chunk('stdout', '第一条\n第二')
    await m.settle()
    expect(m.text()).toContain('第一条')
    held[0]!.ctl.chunk('stdout', '条\n')
    await m.settle()
    expect(m.text()).toContain('第二条')
    held[0]!.ctl.exit()
    await m.settle()
    // 前台跑完了：不再冒充"已运行容器"，那句话只属于后台档
    expect(m.field('编排-提示')).toBeNull()
  })

  it('RB-022 执行期间不放行第二次触发', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    expect(m.text()).toContain('正在执行…')
    expect(isDisabled(m, '编排-执行')).toBe(true)
    await tap(m, '编排-执行')
    expect(held).toHaveLength(1)
    expect(countRuns(fake)).toBe(1)
  })

  it('RB-023 终止说的是杀了谁', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    held[0]!.ctl.chunk('stdout', '已经打出来的半段\n')
    await m.settle()
    await tap(m, '编排-终止')
    expect(m.text()).toContain('已终止 wslc 进程；前台跑的容器可能已随之退出，请到容器页确认。')
    expect(m.text()).toContain('已经打出来的半段')
  })

  it('RB-024 失败时把 wslc 的报错原样呈现，样板话丢掉', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', '不存在的镜像名')
    await tap(m, '编排-执行')
    held[0]!.ctl.chunk('stderr', '错误：无法解析镜像名 不存在的镜像名\n如果此错误是意外错误，请考虑搜索现有问题或新建。\n')
    held[0]!.ctl.exit({ code: 1 })
    await m.settle()
    expect(m.text()).toContain('错误：无法解析镜像名 不存在的镜像名')
    expect(m.text()).not.toContain('如果此错误是意外错误')
  })

  it('RB-025 剪贴板里就是界面上那条', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-复制')
    expect(fake.clipboardText).toBe(cmdLine(m))
    expect(m.text()).toContain('命令已复制到剪贴板。')
  })

  it('RB-027 确认真没复制上才报失败', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    const clipboard = fake.api.clipboard as { writeText: (text: string) => Promise<void> }
    clipboard.writeText = async () => {
      throw new Error('剪贴板被别的进程占用')
    }
    await tap(m, '编排-复制')
    expect(m.text()).toContain('复制到剪贴板失败，请手动选中命令文本。')
  })

  it('RB-051 输出框是纯文本，没执行过时说空话', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    expect(m.text()).toContain('执行后，wslc 的输出显示在这里。')
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    held[0]!.ctl.chunk('stdout', '普通一行，没有着色也没有解析\n')
    await m.settle()
    expect(m.text()).not.toContain('执行后，wslc 的输出显示在这里。')
    expect(m.field('编排-输出')!.tagName).toBe('PRE')
  })

  it('RB-052 终止只杀本应用起的 wslc', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    const kill = m.field('编排-终止') as HTMLButtonElement
    expect(kill.title).toBe('终止 wslc 进程（已在后台跑起来的容器不会因此停下，去容器页管理）')
  })
})

describe('读回一条现成命令', () => {
  it('RB-028 四种写法都认', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    const variants = [
      'wslc run -d nginx',
      'wslc.exe run -d nginx',
      'C:\\tools\\wslc.exe run -d nginx',
      'c:\\Tools\\WSLC.EXE container run -d nginx'
    ]
    for (const line of variants) {
      fake.clipboardText = line
      await tap(m, '编排-粘贴读回')
      expect(value(m, '镜像')).toBe('nginx')
      expect(m.text()).toContain('已从剪贴板读回命令，可以继续在表单里改。')
    }
  })

  it('RB-029 不是 wslc run 的一律拒绝，且不动表单', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'keepme')
    for (const line of ['docker run nginx', 'wslc', 'wslc ps -a']) {
      fake.clipboardText = line
      await tap(m, '编排-粘贴读回')
      expect(m.text()).toContain('这不是 wslc run 命令，没法读回来。')
      expect(value(m, '镜像')).toBe('keepme')
    }
  })

  it('RB-030 剪贴板没文本另说一句', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    fake.clipboardText = '   '
    await tap(m, '编排-粘贴读回')
    expect(m.text()).toContain('剪贴板里没有文本，先复制一条 wslc run 命令再来。')
  })

  it('RB-031 读回来的字段各归各位，命令立刻跟着变', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    fake.clipboardText =
      'wslc run -d --name web -p 8080:80/udp -p 127.0.0.1:53:53 -v C:\\data:/app:ro -e MODE=fast --pull never nginx sleep infinity'
    await tap(m, '编排-粘贴读回')
    expect(value(m, '容器名称 (--name)')).toBe('web')
    expect(rowsOf(m, '主机端口')).toBe(2)
    expect(value(m, '协议')).toBe('udp')
    expect(valueAt(m, '绑定 IP', 1)).toBe('127.0.0.1')
    expect((m.field('编排-只读-1') as HTMLInputElement).checked).toBe(true)
    expect(value(m, '拉取策略 (--pull)')).toBe('never')
    expect(cmdLine(m)).toContain('-p 127.0.0.1:53:53')
    expect(cmdLine(m)).toContain('sleep')
  })

  it('RB-032 认不出的选项连取值整段进「其他参数」', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    fake.clipboardText = 'wslc run --gpus all --dns 8.8.8.8 --ulimit nofile=1024:2048 nginx'
    await tap(m, '编排-粘贴读回')
    expect(value(m, '其他参数（原样追加）')).toBe('--gpus all --dns 8.8.8.8 --ulimit nofile=1024:2048')
    expect(cmdLine(m)).toContain('--gpus all')
  })

  it('RB-033 盘符带冒号与带空格的值都读得回来', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    fake.clipboardText = 'wslc run -e "A=b c" -v C:\\data:/app:ro nginx'
    await tap(m, '编排-粘贴读回')
    expect(value(m, '来源（主机路径或卷名）')).toBe('C:\\data')
    expect(value(m, '容器内路径')).toBe('/app')
    expect((m.field('编排-只读-1') as HTMLInputElement).checked).toBe(true)
    const env = m.container.querySelectorAll<HTMLInputElement>('[aria-label="变量值"]')[0]
    expect(env?.value).toBe('b c')
  })

  it('RB-034 显示→读回→再显示，结果不变', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-自动删除')
    await m.select('拉取策略 (--pull)', 'always')
    await m.type('容器名称 (--name)', 'web')
    await tap(m, '编排-加端口')
    await m.type('主机端口', '8080')
    await m.type('容器端口', '80')
    await m.type('参数', 'sleep infinity')
    const before = cmdLine(m)
    fake.clipboardText = before
    await tap(m, '编排-粘贴读回')
    expect(cmdLine(m)).toBe(before)
  })

  it('RB-035 不选时显示"默认（缺了才拉）"且命令不带 --pull', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    const select = m.field('拉取策略 (--pull)') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.selectedOptions[0]?.textContent).toBe('默认（缺了才拉）')
    expect(cmdLine(m)).not.toContain('--pull')
  })

  it('RB-036 选 never 命令就长出 --pull never', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await m.select('拉取策略 (--pull)', 'never')
    expect(cmdLine(m)).toContain('--pull never')
  })

  it('RB-037 读回带 --pull missing 的命令，那一格跟着变', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    fake.clipboardText = 'wslc run --pull missing nginx'
    await tap(m, '编排-粘贴读回')
    expect(value(m, '拉取策略 (--pull)')).toBe('missing')
    expect(cmdLine(m)).toContain('--pull missing')
  })
})

describe('候选与没有 wslc', () => {
  it('RB-038 候选用 wslc images 的完整引用', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    const expected = parseImages(imagesNdjson())
      .filter(imageIsTagged)
      .map(imageReference)
    const options = Array.from(m.container.querySelectorAll<HTMLOptionElement>('#wsld-run-images option')).map(
      (o) => o.value
    )
    expect(options).toEqual(expect.arrayContaining(expected))
    expect(commands(fake)).toContain('wslc images --format json')
  })

  it('RB-039 没有 wslc 时本页照常可用，只有就地执行说到它', async () => {
    const fake = makeFake({ wslc: null })
    const m = await openRun(fake)
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    await m.type('镜像', 'nginx')
    expect(cmdLine(m)).toBe('wslc run -d nginx')
    await tap(m, '编排-执行')
    expect(m.text()).toContain('这台机器上没有 wslc')
    expect(commands(fake)).toEqual([])
    // 没跑起来的不算执行过，历史仍是空话
    expect(m.text()).toContain('还没有就地执行过命令')
  })
})

describe('清空与历史', () => {
  it('RB-040 清空后回到第一条命令', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-加端口')
    await m.type('主机端口', '8080')
    await m.type('容器端口', '80')
    await tap(m, '编排-执行')
    held[0]!.ctl.chunk('stdout', `${CID}\n`)
    held[0]!.ctl.exit()
    await m.settle()
    await tap(m, '编排-清空')
    expect(cmdLine(m)).toBe('wslc run -d')
    expect((m.field('编排-后台') as HTMLInputElement).checked).toBe(true)
    expect(rowsOf(m, '主机端口')).toBe(0)
    expect(m.text()).toContain('执行后，wslc 的输出显示在这里。')
    expect(m.container.querySelector('.wsld__bar--error')).toBeNull()
    expect(m.container.querySelector('.wsld__bar--ok')).toBeNull()
  })

  it('RB-041 执行进行中不放行清空', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    expect(isDisabled(m, '编排-清空')).toBe(true)
    expect(isDisabled(m, '编排-粘贴读回')).toBe(true)
    expect(value(m, '镜像')).toBe('nginx')
  })

  it('RB-042 跑失败的那条也在历史里', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'broken-image')
    await tap(m, '编排-执行')
    held[0]!.ctl.exit({ code: 1, stderr: '错误：拉不下来\n' })
    await m.settle()
    expect(m.text()).toContain('wslc run -d broken-image')
    expect(m.container.querySelectorAll('.wsld__run-hrow')).toHaveLength(1)
    // 该行显示执行时刻（月-日 时:分:秒）
    expect(m.container.querySelector('.wsld__run-htime')?.textContent).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  })

  it('RB-043 最新在前，连续同一条只记一次', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'one')
    await tap(m, '编排-执行')
    held[0]!.ctl.exit()
    await m.settle()
    await m.type('容器名称 (--name)', 'two')
    await tap(m, '编排-执行')
    const second = cmdLine(m)
    held[1]!.ctl.exit()
    await m.settle()
    await tap(m, '编排-执行')
    held[2]!.ctl.exit()
    await m.settle()
    const list = m.container.querySelectorAll('.wsld__run-hrow')
    expect(list).toHaveLength(2)
    expect(list[0]?.querySelector('.wsld__run-hcmd')?.textContent).toBe(second)
  })

  it('RB-045 点恢复走与剪贴板读回同一条路', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await m.type('容器名称 (--name)', 'web')
    await tap(m, '编排-执行')
    const executed = cmdLine(m)
    held[0]!.ctl.exit()
    await m.settle()
    await m.type('容器名称 (--name)', '别的名字')
    await tap(m, '编排-恢复-1')
    expect(cmdLine(m)).toBe(executed)
    expect(m.text()).toContain('已从执行历史读回命令，可以继续在表单里改。')
    // 与把同一条命令贴进剪贴板读回完全一样
    fake.clipboardText = executed
    await tap(m, '编排-粘贴读回')
    expect(cmdLine(m)).toBe(executed)
  })

  it('RB-046 执行中点恢复只给提示不改表单', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'first')
    await tap(m, '编排-执行')
    held[0]!.ctl.exit()
    await m.settle()
    await m.type('镜像', 'second')
    await tap(m, '编排-执行')
    await tap(m, '编排-恢复-1')
    expect(m.text()).toContain('正在执行，先取消或等它跑完再恢复历史。')
    expect(value(m, '镜像')).toBe('second')
  })

  it('RB-047 没执行过时历史说的是空话', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    expect(m.text()).toContain('还没有就地执行过命令。执行过的命令按最新在前留在这里，最多 100 条。')
  })

  it('RB-048 重开应用历史就没了', async () => {
    const { fake, held } = stage()
    const m = await openRun(fake)
    await m.type('镜像', 'nginx')
    await tap(m, '编排-执行')
    held[0]!.ctl.exit()
    await m.settle()
    expect(m.text()).toContain('wslc run -d nginx')
    m.unmount()

    const again = stage()
    const m2 = await openRun(again.fake)
    expect(m2.text()).toContain('还没有就地执行过命令')
  })

  it('RB-049 界面上找不到 run 以外的入口', async () => {
    const { fake } = stage()
    const m = await openRun(fake)
    const text = m.text().toLowerCase()
    expect(text).not.toContain('compose')
    expect(text).not.toContain('build')
  })
})

function countRuns(fake: FakeAirship): number {
  return fake.procCalls.filter((call) => call.args[0] === 'run').length
}
