import { describe, expect, it } from 'vitest'
import { fromState, isFinished, JobQueue, statusText, uniquePath, type JobSpec } from '../jobs'
import { createState, type AppState, type ProbeInfo, type StreamInfo } from '../state'

/** 移植自 SelfTest.cs [10] 任务队列（纯逻辑，不真跑）。 */

function st(rel: number, type: string, codec: string, lang = '', w = 0, h = 0): StreamInfo {
  return {
    index: rel,
    rel,
    type,
    lang,
    codec,
    w,
    h,
    fps: 0,
    channels: 0,
    sampleRate: 0,
    bitrate: 0,
    isDefault: false,
    forced: false,
    attachedPic: false,
    title: ''
  }
}

function probe(): ProbeInfo {
  return {
    path: 'T:/4k_demo.mp4',
    name: '4k_demo.mp4',
    dir: 'T:',
    size: 1 << 20,
    duration: 4,
    durationText: '00:00:04',
    bitrate: 0,
    format: 'mp4',
    streams: [st(0, 'video', 'hevc', '', 3840, 2160), st(0, 'audio', 'aac', 'chi'), st(1, 'audio', 'aac', 'eng')]
  }
}

function cfg(): AppState {
  const s = createState()
  s.probe = probe()
  s.keep.videoRel = 0
  s.keep.audioRels.push(0)
  s.scale.on = true
  s.scale.w = 1920
  s.scale.h = -2
  s.out.path = 'T:/_q_a.mp4'
  return s
}

describe('[10] 任务队列', () => {
  it('快照冻结：提交后改界面不影响已提交任务', () => {
    const q = new JobQueue()
    const c = cfg()

    const first = fromState(c, q, {})
    expect(first.spec).toBeTruthy()
    q.enqueue(first.spec!)

    c.out.crf = '30'
    c.scale.w = 1280
    const second = fromState(c, q, {})
    q.enqueue(second.spec!)

    expect(first.spec!.args).toContain('20')
    expect(first.spec!.args.some((a) => a.includes('scale=w=1920'))).toBe(true)
    expect(second.spec!.args).toContain('30')
    expect(second.spec!.args.some((a) => a.includes('scale=w=1280'))).toBe(true)
  })

  it('同路径没跑完 → 自动改名 _2', () => {
    const q = new JobQueue()
    const c = cfg()
    const a = fromState(c, q, {})
    q.enqueue(a.spec!)
    const b = fromState(c, q, {})
    expect(b.spec!.outPath.endsWith('_q_a_2.mp4')).toBe(true)
  })

  it('序号 / 取任务 / 失败不挡后面 / 停止 / 清空 / 单独移除', () => {
    const q = new JobQueue()
    const c = cfg()
    const a = fromState(c, q, {})
    q.enqueue(a.spec!)
    c.out.crf = '30'
    const b = fromState(c, q, {})
    q.enqueue(b.spec!)

    expect(`${a.spec!.no},${b.spec!.no}`).toBe('1,2')

    q.running = a.spec
    expect(q.nextReady()).toBeNull()
    q.running = null
    expect(q.nextReady()?.no).toBe(1)

    a.spec!.state = 'error'
    a.spec!.error = '模拟失败'
    expect(q.nextReady()?.no).toBe(2)

    q.stopAll()
    expect(q.pending).toBe(0)

    b.spec!.state = 'done'
    expect(q.clearFinished()).toBe(1)
    expect(q.jobs[0]!.state).toBe('error')

    // 已跑完的输出也占着名字，后一个不会盖掉前一个的成品
    const c3 = fromState(c, q, {})
    expect(c3.spec).toBeTruthy()
    expect(c3.spec!.outPath.endsWith('_q_a_2.mp4')).toBe(true)
    q.enqueue(c3.spec!)

    const removed = q.remove(q.jobs[0]!)
    expect(removed).toBe(true)
    expect(q.jobs.length).toBe(1)
  })

  it('uniquePath 撞名递增', () => {
    expect(uniquePath('T:/a.mp4', ['T:/a.mp4'])).toBe('T:/a_2.mp4')
    expect(uniquePath('T:/a.mp4', ['T:/a.mp4', 'T:/a_2.mp4'])).toBe('T:/a_3.mp4')
    expect(uniquePath('T:/b.mp4', ['T:/a.mp4'])).toBe('T:/b.mp4')
  })

  it('状态文案', () => {
    const j: JobSpec = {
      id: 'x',
      no: 1,
      title: 't',
      args: [],
      outPath: 'T:/o.mp4',
      durationSec: 1,
      tempFiles: [],
      state: 'queued',
      error: '',
      note: '',
      outSize: 0,
      pct: 0,
      speed: '',
      startedAt: null,
      finishedAt: null
    }
    expect(statusText(j)).toBe('排队中')
    expect(isFinished(j)).toBe(false)
    j.state = 'done'
    expect(isFinished(j)).toBe(true)
  })
})
