import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { build } from '../command'
import { parseProbe, subSnippet } from '../probe'
import { createState, type AppState } from '../state'

/**
 * 真素材 / 真编码用例，对应 SelfTest.cs 的 [3][6][7][8]。
 * 默认跳过（npm test 保持快），用 VCP_E2E=1 打开：
 *   VCP_E2E=1 npx vitest run e2e
 *
 * 素材与 ffmpeg 位置用环境变量给，不给就回落到本机的已知位置，没有就跳过——
 * 不让测试因为环境差异假失败。
 */

const FIXTURES =
  process.env.VCP_FIXTURES ?? 'C:/Users/xyzwp/Develop/vcp/code/ffmpeg-avalonia/fixtures'
const FFMPEG =
  process.env.VCP_FFMPEG ??
  'C:/Users/xyzwp/AppData/Roaming/Python/Python313/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe'

const haveFixtures = existsSync(join(FIXTURES, '4k_demo.mp4'))
const haveFfmpeg = existsSync(FFMPEG)
const enabled = process.env.VCP_E2E === '1' && haveFixtures && haveFfmpeg

const made: string[] = []

function run(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  return { code: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function probe(path: string) {
  const res = run(['-hide_banner', '-i', path])
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return parseProbe(res.stderr, {
    path,
    name: path.slice(slash + 1),
    dir: path.slice(0, slash),
    size: statSync(path).size
  })
}

function startJob(args: string[]): { pid: number; kill(): void; wait(): Promise<number | null>; feed(line: string): void; onLine: ((l: string) => void) | null } {
  const child = spawn(FFMPEG, ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args], {
    windowsHide: true
  })
  const job = {
    pid: child.pid ?? -1,
    onLine: null as ((l: string) => void) | null,
    feed(line: string): void {
      job.onLine?.(line)
    },
    kill(): void {
      child.kill('SIGKILL')
    },
    wait(): Promise<number | null> {
      return new Promise((resolve) => child.on('close', (code) => resolve(code)))
    }
  }
  let buf = ''
  child.stdout.on('data', (b: Buffer) => {
    buf += b.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      job.feed(line)
    }
  })
  child.stderr.resume()
  return job
}

afterAll(() => {
  for (const f of made) {
    try {
      rmSync(f, { force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

describe.skipIf(!enabled)('[e2e] 真素材与真编码', () => {
  it('[3] 探测 4k_demo.mp4', () => {
    const info = probe(join(FIXTURES, '4k_demo.mp4'))
    expect(Math.round(info.duration)).toBe(4)
    expect(info.streams.length).toBe(3)
    const v = info.streams.find((s) => s.type === 'video')!
    expect(`${v.w}x${v.h}`).toBe('3840x2160')
    const aud = info.streams.filter((s) => s.type === 'audio')
    expect(aud.map((a) => `${a.rel}:${a.lang}`).join(',')).toBe('0:chi,1:eng')
    expect(aud.map((a) => a.isDefault).join(',')).toBe('true,false')
  })

  it('[3b] multi_sub.mkv 的三条字幕轨', () => {
    const info = probe(join(FIXTURES, 'multi_sub.mkv'))
    const subs = info.streams.filter((s) => s.type === 'subtitle')
    expect(subs.length).toBe(3)
    expect(subs.map((s) => s.lang).join(',')).toBe('eng,chi,jpn')
    expect(subs.map((s) => s.title).join(',')).toBe('English,简体中文,')
  })

  it('[3c] 外挂字幕直接读文件', () => {
    const raw = readFileSync(join(FIXTURES, '4k_demo.srt'), 'utf8')
    expect(subSnippet(raw)).toBe('第一条字幕 ／ second line')
  })

  it('[6] 抽取内嵌字幕', () => {
    const dest = join(FIXTURES, '_e2e_sub.srt')
    made.push(dest)
    const res = run(['-y', '-hide_banner', '-loglevel', 'error', '-i', join(FIXTURES, 'with_sub.mkv'), '-map', '0:s:0', dest])
    expect(res.code).toBe(0)
    expect(readFileSync(dest, 'utf8')).toContain('第一条字幕')
  })

  it('[7] 真实编码 4K → 1080p 档位 + 烧入字幕', async () => {
    const subPath = join(FIXTURES, '_e2e_sub.srt')
    if (!existsSync(subPath)) {
      const r = run(['-y', '-hide_banner', '-loglevel', 'error', '-i', join(FIXTURES, 'with_sub.mkv'), '-map', '0:s:0', subPath])
      expect(r.code).toBe(0)
      made.push(subPath)
    }

    const info = probe(join(FIXTURES, 'with_sub.mkv'))
    const s = createState()
    s.probe = info
    s.keep.videoRel = 0
    s.keep.audioRels.push(0)
    s.scale.on = true
    s.scale.p = 1080
    s.keep.subMode = 'burn'
    s.keep.subs.push({ embedded: true, rel: 0, extId: 0, path: '', name: '' })
    s.extracted['s0'] = subPath
    s.out.path = join(FIXTURES, '_e2e_encode.mp4').replace(/\\/g, '/')
    s.out.preset = 'veryfast'
    s.out.crf = '30'
    made.push(s.out.path)

    const args = build(s)
    expect(args.some((a) => a.includes('@EXTRACT@'))).toBe(false)

    const job = startJob(args)
    let time = ''
    let speed = ''
    job.onLine = (line) => {
      const t = /^(?:out_time|time)=(\d+:\d+:\d+\.\d+)/.exec(line)
      if (t && t[1] !== '00:00:00.000000') time = t[1]!
      const sp = /^speed=([0-9.]+)x/.exec(line)
      if (sp) speed = `${sp[1]}x`
    }
    const code = await job.wait()
    expect(code).toBe(0)
    expect(time.length).toBeGreaterThan(0)
    expect(speed.endsWith('x')).toBe(true)
    expect(statSync(s.out.path).size).toBeGreaterThan(1000)

    const out = probe(s.out.path)
    const cv = out.streams.find((x) => x.type === 'video')!
    // 档位落在高上，宽按比例算并取偶数（scale=-2:1080）
    expect(cv.h).toBe(1080)
    expect(cv.w % 2).toBe(0)
    expect(out.streams.find((x) => x.type === 'audio')?.lang).toBe('chi')
    expect(out.streams.filter((x) => x.type === 'subtitle').length).toBe(0)
  }, 120000)

  it('[8] 停止任务', async () => {
    const out = join(FIXTURES, '_e2e_long.mp4').replace(/\\/g, '/')
    made.push(out)
    const job = startJob([
      '-y', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=600',
      '-c:v', 'libx264', '-preset', 'medium', out
    ])
    await new Promise((r) => setTimeout(r, 1500))
    job.kill()
    const code = await job.wait()
    // 被 kill 的进程退出码非 0（或已被系统回收）
    expect(code).not.toBe(0)
  }, 30000)
})
