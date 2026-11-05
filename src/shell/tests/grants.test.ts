import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * GR-001 ~ GR-004、GR-006、GR-009：路径授权表本身。
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
const { appCacheDir, appDataDir, isInside, resolveInData, resolveInShared, sharedDir } = await import(
  '../main/services/paths'
)
const { grants } = await import('../main/services/grants')

const slash = (p: string): string => p.replace(/\\/g, '/')

describe('应用自己的地盘', () => {
  it('GR-001 自己 data 与 cache 里的路径直接可读写', () => {
    const data = join(appDataDir('vcp'), 'jobs.json')
    const cache = join(appCacheDir('vcp'), 'sub.srt')
    expect(grants.canRead('vcp', data)).toBe(true)
    expect(grants.canWrite('vcp', cache)).toBe(true)
    expect(slash(appDataDir('vcp'))).toMatch(/apps\/vcp\/data$/)
    expect(slash(appCacheDir('vcp'))).toMatch(/apps\/vcp\/cache$/)
  })

  it('GR-002 别的应用的地盘读不到也写不进', () => {
    const other = join(appDataDir('pdf'), 'library.json')
    expect(grants.canRead('vcp', other)).toBe(false)
    expect(grants.canWrite('vcp', other)).toBe(false)

    expect(() => grants.assertRead('vcp', other)).toThrowError(
      `没有读取权限：${other}（只能读应用数据目录，或先用文件对话框选中它）`
    )
    expect(() => grants.assertWrite('vcp', other)).toThrowError(/^没有写入权限：/)
  })

  it('GR-003 越界拼路径在解析这一步就挡住', () => {
    expect(() => resolveInData('vcp', ['..', 'pdf', 'secret.txt'])).toThrowError(/^路径越界：/)
    const why = (() => {
      try {
        resolveInData('vcp', ['..', 'x'])
        return ''
      } catch (err) {
        return (err as Error).message
      }
    })()
    expect(why).toContain('不在vcp 的数据目录内')

    // 想借共享区跳出去也一样
    expect(() => resolveInShared('library', ['..', '..', 'etc'])).toThrowError(/不在共享命名空间 library内/)
  })
})

describe('共享命名空间与显式授权', () => {
  const root = join(__dirname, '.tmp', 'grants-userData')

  it('GR-004 声明过的共享区可读写，没声明的应用碰不到', () => {
    const book = join(sharedDir('library'), 'files', 'a.epub')
    // books 在清单里声明了 library
    expect(grants.canRead('books', book)).toBe(true)
    expect(grants.canWrite('books', book)).toBe(true)
    // vcp 没声明，同一条路径就不给
    expect(grants.canRead('vcp', book)).toBe(false)
    expect(slash(sharedDir('library'))).toMatch(/shared\/library$/)
  })

  it('GR-006 选中一个目录，它下面任意深度都可读', () => {
    const picked = join(root, '..', 'media')
    grants.grantRead('vcp', picked)
    expect(grants.canRead('vcp', join(picked, 'deep', 'inside', 'file.mkv'))).toBe(true)
    expect(grants.canRead('vcp', join(root, 'elsewhere'))).toBe(false)
  })

  it('GR-007 只授文件本身时，同目录的另一个文件读不到', () => {
    const one = join(root, 'src', 'a.mp4')
    grants.grantRead('vcp', one)
    expect(grants.canRead('vcp', one)).toBe(true)
    expect(grants.canRead('vcp', join(root, 'src', 'b.mp4'))).toBe(false)
  })

  it('GR-008 写只开放给选中的那一个路径，但所在目录可读（写完能回读校验）', () => {
    const target = join(root, 'out', 'final.mkv')
    grants.grantWrite('vcp', target)
    grants.grantRead('vcp', join(root, 'out'))

    expect(grants.canWrite('vcp', target)).toBe(true)
    expect(grants.canWrite('vcp', join(root, 'out', 'other.mkv'))).toBe(false)
    expect(grants.canRead('vcp', target)).toBe(true)
  })

  it('GR-009 授权条数查得到，给诊断用', () => {
    const before = grants.stats('dagogo')
    grants.grantRead('dagogo', join(root, 'x'))
    grants.grantWrite('dagogo', join(root, 'y'))
    const after = grants.stats('dagogo')
    expect(after.read).toBe(before.read + 1)
    expect(after.write).toBe(before.write + 1)
  })

  it('GR-006b 路径包含判定不被前缀同名目录骗过去', () => {
    const base = join(appDataDir('vcp'))
    expect(isInside(base, join(base, 'nested', 'f'))).toBe(true)
    expect(isInside(base, `${base}2`)).toBe(false)
    expect(isInside(base, base)).toBe(true)
  })
})
