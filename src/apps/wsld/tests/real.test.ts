import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { cleanWslcError, parseContainers, parseImages } from '../parse'
import { imageReference, containerName } from '../model'

/**
 * 真机门控（对应原版的 RealWslc*IntegrationTests）。
 *
 * 默认整段跳过，只有 `AIRSHIP_WSLD_INTEGRATION=1` 才跑。
 * 它直接问本机的 wslc.exe，**只跑只读命令**：这是用户自己的机器，
 * 建容器、删容器、拉镜像那类会留下痕迹的动作一概不碰。
 *
 *   $env:AIRSHIP_WSLD_INTEGRATION = "1"; npx vitest run src/apps/wsld/tests/real.test.ts
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
})
