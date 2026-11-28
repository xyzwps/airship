import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GR-001 ~ GR-003、GR-006 ~ GR-009：路径授权表本身。
 *
 * 跑的是真 grants.ts（真 paths.ts 的目录布局），对话框那一步给出去的许可在 `bridge.test.ts` 里验，
 * 因为"选中即授权"是 ipc.ts 那条流程的事。
 */

vi.mock('electron', async () => {
  const { join } = await import('node:path')
  const { mkdirSync, rmSync } = await import('node:fs')
  const root = join(__dirname, '.tmp', 'grants-userData')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return {
    app: { getPath: () => root, getVersion: () => '0.0.0-test' },
    ipcMain: { handle: () => undefined, on: () => undefined }
  }
})

const { join } = await import('node:path')
const { appCacheDir, appDataDir, isInside, resolveInData } = await import(
  '../main/services/paths'
)
const { grants } = await import('../main/services/grants')

const slash = (p: string): string => p.replace(/\\/g, '/')

describe('应用自己的地盘', () => {
  it('GR-001 自己 data 与 cache 里的路径直接可读写', () => {
    const data = join(appDataDir('airship-ffmpeg'), 'jobs.json')
    const cache = join(appCacheDir('airship-ffmpeg'), 'sub.srt')
    expect(grants.canRead('airship-ffmpeg', data)).toBe(true)
    expect(grants.canWrite('airship-ffmpeg', cache)).toBe(true)
    expect(slash(appDataDir('airship-ffmpeg'))).toMatch(/\.airship\/data\/airship-ffmpeg$/)
    expect(slash(appCacheDir('airship-ffmpeg'))).toMatch(/\.airship\/data\/airship-ffmpeg\/cache$/)
  })

  it('GR-002 别的应用的地盘读不到也写不进', () => {
    const other = join(appDataDir('airship-s3'), 'library.json')
    expect(grants.canRead('airship-ffmpeg', other)).toBe(false)
    expect(grants.canWrite('airship-ffmpeg', other)).toBe(false)

    expect(() => grants.assertRead('airship-ffmpeg', other)).toThrowError(
      `没有读取权限：${other}（只能读应用数据目录，或先用文件对话框选中它）`
    )
    expect(() => grants.assertWrite('airship-ffmpeg', other)).toThrowError(/^没有写入权限：/)
  })

  it('GR-003 越界拼路径在解析这一步就挡住', () => {
    expect(() => resolveInData('airship-ffmpeg', ['..', 'airship-s3', 'secret.txt'])).toThrowError(/^路径越界：/)
    const why = (() => {
      try {
        resolveInData('airship-ffmpeg', ['..', 'x'])
        return ''
      } catch (err) {
        return (err as Error).message
      }
    })()
    expect(why).toContain('不在airship-ffmpeg 的数据目录内')
  })
})

describe('显式授权', () => {
  const root = join(__dirname, '.tmp', 'grants-userData')

  it('GR-006 选中一个目录，它下面任意深度都可读', () => {
    const picked = join(root, '..', 'media')
    grants.grantRead('airship-ffmpeg', picked)
    expect(grants.canRead('airship-ffmpeg', join(picked, 'deep', 'inside', 'file.mkv'))).toBe(true)
    expect(grants.canRead('airship-ffmpeg', join(root, 'elsewhere'))).toBe(false)
  })

  it('GR-007 只授文件本身时，同目录的另一个文件读不到', () => {
    const one = join(root, 'src', 'a.mp4')
    grants.grantRead('airship-ffmpeg', one)
    expect(grants.canRead('airship-ffmpeg', one)).toBe(true)
    expect(grants.canRead('airship-ffmpeg', join(root, 'src', 'b.mp4'))).toBe(false)
  })

  it('GR-008 写只开放给选中的那一个路径，但所在目录可读（写完能回读校验）', () => {
    const target = join(root, 'out', 'final.mkv')
    grants.grantWrite('airship-ffmpeg', target)
    grants.grantRead('airship-ffmpeg', join(root, 'out'))

    expect(grants.canWrite('airship-ffmpeg', target)).toBe(true)
    expect(grants.canWrite('airship-ffmpeg', join(root, 'out', 'other.mkv'))).toBe(false)
    expect(grants.canRead('airship-ffmpeg', target)).toBe(true)
  })

  it('GR-009 授权条数查得到，给诊断用', () => {
    const before = grants.stats('airship-dago')
    grants.grantRead('airship-dago', join(root, 'x'))
    grants.grantWrite('airship-dago', join(root, 'y'))
    const after = grants.stats('airship-dago')
    expect(after.read).toBe(before.read + 1)
    expect(after.write).toBe(before.write + 1)
  })

  it('GR-006b 路径包含判定不被前缀同名目录骗过去', () => {
    const base = join(appDataDir('airship-ffmpeg'))
    expect(isInside(base, join(base, 'nested', 'f'))).toBe(true)
    expect(isInside(base, `${base}2`)).toBe(false)
    expect(isInside(base, base)).toBe(true)
  })
})
