import { describe, expect, it } from 'vitest'
import {
  ALL_LINES,
  MAX_TAIL_LINES,
  TAIL_CHOICES,
  containerActionArgs,
  logsArgs,
  pullArgs,
  rmiArgs,
  tailLabel
} from '../cli'

/**
 * 起进程之前那一道门（node 环境，不开界面）。
 *
 * 实测 `wslc logs -n 0` / `-n abc` 只换回 8 行 usage 加退出码 1（见 fixtures/wslc 里那份样本），
 * 对使用者毫无价值，所以非法输入在拼命令这一步就该被挡下 ——
 * 命令拼不出来，进程自然一个都不起。
 */

describe('日志请求的拼装与校验', () => {
  it('WL-006 越界的行数在拼命令那一步就被挡下', () => {
    const bad = [-1, 1.5, MAX_TAIL_LINES + 1, Number.NaN]
    for (const tailLines of bad) {
      let message = ''
      try {
        logsArgs({ follow: false, containerRef: 'c1', tailLines, timestamps: false })
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message, `行数 ${tailLines} 不该被拼进命令`).toContain('日志行数得是')
      expect(message).toContain(String(MAX_TAIL_LINES))
      // 换回来的不是 wslc 那 8 行 usage
      expect(message).not.toContain('使用情况')
    }
  })

  it('行数取 0 表示全部，此时一条行数参数都不带', () => {
    expect(tailLabel(ALL_LINES)).toBe('全部')
    expect(TAIL_CHOICES).toEqual([100, 200, 500, 1000, 2000, ALL_LINES])
    expect(logsArgs({ follow: false, containerRef: 'c1', tailLines: ALL_LINES, timestamps: true })).toEqual([
      'logs',
      '-t',
      'c1'
    ])
  })

  it('WL-005 空容器标识拼不出命令', () => {
    for (const ref of ['', '   ']) {
      expect(() =>
        logsArgs({ follow: false, containerRef: ref, tailLines: 100, timestamps: false })
      ).toThrow('容器标识不能为空。')
      expect(() =>
        logsArgs({ follow: true, containerRef: ref, timestamps: false, sinceEpochSeconds: 1_700_000_000 })
      ).toThrow('容器标识不能为空。')
    }
  })

  it('WL-029 拿不到正的起点就不拼实时的命令', () => {
    for (const since of [0, -1, 1.5, undefined]) {
      expect(() =>
        logsArgs({ follow: true, containerRef: 'c1', timestamps: false, sinceEpochSeconds: since })
      ).toThrow('实时日志要给起点')
    }
  })
})

describe('其余命令的输入门', () => {
  it('CA-007 空容器 ID 拼不出四个动作的任何一条', () => {
    for (const action of ['start', 'stop', 'restart', 'remove'] as const) {
      for (const id of ['', '   ']) {
        expect(() => containerActionArgs(action, id)).toThrow('容器 ID 不能为空。')
      }
    }
    // 删除运行中的容器才带 -f，其余三条永远不带
    expect(containerActionArgs('remove', ' c1 ')).toEqual(['remove', 'c1'])
    expect(containerActionArgs('remove', 'c1', true)).toEqual(['remove', '-f', 'c1'])
    expect(containerActionArgs('stop', 'c1', true)).toEqual(['stop', 'c1'])
  })

  it('IM-008 镜像引用去首尾空白，一次只交一个；空引用拼不出命令', () => {
    expect(pullArgs('  redis:7  ')).toEqual(['pull', 'redis:7'])
    expect(rmiArgs('  redis:7')).toEqual(['rmi', 'redis:7'])
    expect(rmiArgs('redis:7', true)).toEqual(['rmi', '-f', 'redis:7'])
    expect(() => pullArgs('   ')).toThrow('镜像引用不能为空。')
    expect(() => rmiArgs('')).toThrow('镜像引用不能为空。')
  })
})
