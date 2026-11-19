import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { targetsFor, type WindowRef } from '../main/services/routing'

/**
 * 窗口化买到的东西是隔离，这里验隔离的两条硬规则：
 *   1. 事件只投递给归属窗口（routing 是真正被 windows.ts 调用的那份逻辑）；
 *   2. 渲染侧拿不到 ipcRenderer，也就没法自己发跨窗口消息。
 * runtime 自己没有窗口，台账里只有应用。
 */

const WINDOWS: WindowRef[] = [
  { contentsId: 1, owner: 'dagogo' },
  { contentsId: 2, owner: 'vcp' },
  { contentsId: 3, owner: 'books' },
  { contentsId: 4, owner: 'vcp' } // 同一应用重开（理论上不该有两个，路由规则仍要正确）
]

describe('事件路由', () => {
  it('BR-010 A 应用的事件不会投给 B 应用的窗口', () => {
    expect(targetsFor('vcp', WINDOWS)).toEqual([2, 4])
    expect(targetsFor('vcp', WINDOWS)).not.toContain(3)
    expect(targetsFor('books', WINDOWS)).toEqual([3])
    expect(targetsFor('dagogo', WINDOWS)).toEqual([1])
  })

  it('BR-010b 归属不存在时返回空：事件被丢弃，绝不广播兜底', () => {
    // 应用窗口已关，此时广播等于把它的转码进度发给别人——不能这么干
    expect(targetsFor('pdf', WINDOWS)).toEqual([])
  })
})

describe('渲染侧拿不到 ipcRenderer', () => {
  const preloadSource = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')

  it('BR-009 没有把 ipcRenderer 整体暴露出去', () => {
    // exposeInMainWorld('x', ipcRenderer) 这种写法一旦出现，隔离就形同虚设
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer\s*\)/)
  })

  it('BR-009b 桥只暴露 airship 一套面，事件只走一个频道', () => {
    expect(preloadSource).toMatch(/exposeInMainWorld\('airship',\s*bridge\)/)
    // 启动器退场后没有第二套应用面。唯一的另一处暴露是截图工装钩子，
    // 且必须关在 shotMode 的门里——正常启动时它不存在。
    const exposures = [...preloadSource.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map((m) => m[1])
    expect(exposures).toEqual(['airship', '__airshipShot'])
    expect(preloadSource).toMatch(/if \(shotMode\) \{\s*\n\s*contextBridge\.exposeInMainWorld\('__airshipShot'/)
    expect(preloadSource).not.toContain('airshipShell')
    expect(preloadSource).toContain("ipcRenderer.on('airship:event'")
  })
})