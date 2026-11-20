import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { cleanWslcError, parseContainers, parseImages } from '../parse'
import { imageReference, containerName } from '../model'
import { emptyRunSpec, runArgs, runCommand, tryParseRun } from '../run'

/**
 * 真机门控（对应原版的 RealWslc*IntegrationTests）。
 *
 * 默认整段跳过，只有 `AIRSHIP_WSLD_INTEGRATION=1` 才跑。
 * 它直接问本机的 wslc.exe：读命令随便跑；唯一的例外是那条 `run -d --rm hello-world`
 * ——--rm 让容器退出即消，收尾再确认一遍没留痕，用完的机器和用之前一样干净。
 *
 *   just wsld-real
 */

const ENABLED = process.env['AIRSHIP_WSLD_INTEGRATION'] === '1'
const EXE = process.env['AIRSHIP_WSLC_PATH'] ?? 'C:\\Program Files\\WSL\\wslc.exe'
const run = promisify(execFile)

interface Answer {
  code: number
  stdout: string
  stderr: string
}

async function wslc(args: string[]): Promise<Answer> {
  try {
    const out = await run(EXE, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
    return { code: 0, stdout: out.stdout, stderr: out.stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

const gated = ENABLED ? describe : describe.skip

gated('本机 wslc 的真实输出', () => {
  it('CL-001 CL-022 真机 list 的输出被解析器吃下，一行不多一行不少', async () => {
    expect(existsSync(EXE), `本机没有 ${EXE}`).toBe(true)

    const answer = await wslc(['list', '-a', '--format', 'json'])
    expect(answer.code, cleanWslcError(answer.stderr)).toBe(0)

    const lines = answer.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const containers = parseContainers(answer.stdout)
    expect(containers).toHaveLength(lines.length)
    expect(containers.every((c) => c.id.length > 0)).toBe(true)
    // 名称取 Names 首个并去掉前导斜杠；没有名称的行仍能用 ID 认
    for (const container of containers) {
      expect(containerName(container.names).length > 0 || container.id.length > 0).toBe(true)
    }
  }, 60_000)

  it('IM-001 IM-002 IM-007 真机 images 的输出被吃下，每个镜像都认得出引用', async () => {
    const answer = await wslc(['images', '--format', 'json'])
    expect(answer.code, cleanWslcError(answer.stderr)).toBe(0)

    const lines = answer.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
    const images = parseImages(answer.stdout)
    expect(images).toHaveLength(lines.length)
    for (const image of images) {
      // 有标签用 仓库:标签，没标签退化成 ID——绝不会是 <none>:<none>
      expect(imageReference(image).length).toBeGreaterThan(0)
      expect(imageReference(image)).not.toContain('<none>')
    }
  }, 60_000)

  it('WL-016 读一个不存在的容器，wslc 说的错被洗成一句人话', async () => {
    const answer = await wslc(['logs', '-n', '5', 'airship-没有这个容器'])
    expect(answer.code).not.toBe(0)

    const shown = cleanWslcError(answer.stderr)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).toContain('错误代码')
    // 那句"欢迎提 issue"的样板话不该出现在界面上
    expect(shown).not.toContain('如果此错误是意外错误')
  }, 60_000)

  it('WL-015 已停着的容器读不到东西也算正常，不是失败', async () => {
    const listed = await wslc(['list', '-a', '--format', 'json'])
    const containers = parseContainers(listed.stdout)
    const target = containers.find((c) => c.id.length > 0)
    if (!target) return // 本机一个容器都没有，这条就不适用

    const answer = await wslc(['logs', '-n', '3', target.id])
    // 实测：已退出的容器多半是退出码 0 + 空输出，界面据此说"没有输出"
    expect(answer.code, cleanWslcError(answer.stderr)).toBe(0)
  }, 60_000)

  it('RB-020 真机 run -d --rm 拿回 64 位容器 ID，退出即消不留痕', async () => {
    // 本机多半只有镜像源前缀的 hello-world（裸名拉不动外网），先问本地清单
    const listed0 = await wslc(['images', '--format', 'json'])
    const local = parseImages(listed0.stdout)
      .map(imageReference)
      .find((ref) => ref.includes('hello-world'))
    const spec = emptyRunSpec()
    spec.image = local ?? 'hello-world'
    spec.detach = true
    spec.rm = true

    const answer = await wslc(runArgs(spec))
    expect(answer.code, cleanWslcError(answer.stderr)).toBe(0)
    const id = answer.stdout.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
    expect(id, `wslc 写回的容器 ID 不像 64 位十六进制：${JSON.stringify(id)}`).toMatch(/^[0-9a-f]{64}$/i)

    // --rm 的账在这里对：跑完的 hello-world 不该还挂在列表里
    const listed = await wslc(['list', '-a', '--format', 'json'])
    expect(parseContainers(listed.stdout).some((c) => c.id === id)).toBe(false)

    // 界面上那条与交给 wslc 的逐段一致，且原样读回来还是同一条（RB-003/034 的真机版）
    const display = runCommand(spec)
    const parsed = tryParseRun(display)
    expect(parsed).not.toBeNull()
    expect(runCommand(parsed!)).toBe(display)
  }, 120_000)

  it('RB-024 真机跑一个不存在的镜像，stderr 洗出来的是人话不是样板', async () => {
    const answer = await wslc(['run', '-d', 'airship-没有这个镜像:0'])
    expect(answer.code).not.toBe(0)
    const shown = cleanWslcError(answer.stderr)
    expect(shown.length).toBeGreaterThan(0)
    expect(shown).not.toContain('如果此错误是意外错误')
  }, 60_000)
})
