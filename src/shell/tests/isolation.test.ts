import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allTargets, targetsFor, type WindowRef } from '../main/services/routing'

/**
 * 窗口化买到的东西是隔离，这里验隔离的两条硬规则：
 *   1. 事件只投递给归属窗口（routing 是真正被 windows.ts 调用的那份逻辑）；
 *   2. 渲染侧拿不到 ipcRenderer，也就没法自己发跨窗口消息。
 */

const WINDOWS: WindowRef[] = [
  { contentsId: 1, owner: 'shell' },
  { contentsId: 2, owner: 'vcp' },
  { contentsId: 3, owner: 'books' },
  { contentsId: 4, owner: 'vcp' } // 同一应用重开（理论上不该有两个，路由规则仍要正确）
]

describe('事件路由', () => {
  it('BR-010 A 应用的事件不会投给 B 应用的窗口', () => {
    expect(targetsFor('vcp', WINDOWS)).toEqual([2, 4])
    expect(targetsFor('vcp', WINDOWS)).not.toContain(3)
    expect(targetsFor('books', WINDOWS)).toEqual([3])
  })

  it('启动器的事件不会漏给任何应用窗口', () => {
    expect(targetsFor('shell', WINDOWS)).toEqual([1])
  })

  it('BR-010b 归属不存在时返回空：事件被丢弃，绝不广播兜底', () => {
    // 应用窗口已关，此时广播等于把它的转码进度发给别人——不能这么干
    expect(targetsFor('pdf', WINDOWS)).toEqual([])
  })

  it('广播才真的发给所有窗口', () => {
    expect(allTargets(WINDOWS)).toEqual([1, 2, 3, 4])
  })
})

describe('渲染侧拿不到 ipcRenderer', () => {
  const preloadSource = readFileSync(join(__dirname, '..', 'preload', 'index.ts'), 'utf8')

  it('BR-009 没有把 ipcRenderer 整体暴露出去', () => {
    // exposeInMainWorld('x', ipcRenderer) 这种写法一旦出现，隔离就形同虚设
    expect(preloadSource).not.toMatch(/exposeInMainWorld\(\s*['"][^'"]+['"]\s*,\s*ipcRenderer\s*\)/)
  })

  it('暴露的都是包好的对象，且事件只走一个频道', () => {
    expect(preloadSource).toMatch(/exposeInMainWorld\('airship',\s*bridge\)/)
    expect(preloadSource).toMatch(/exposeInMainWorld\('airshipShell',\s*shellBridge\)/)
    expect(preloadSource).toContain("ipcRenderer.on('airship:event'")
  })

  it('BR-005b 应用窗口拿不到启动器的面（开不了别人的窗口）', () => {
    // airshipShell 只在 IS_SHELL 分支里暴露。
    // 判据是"这一句出现在那个分支之内"，不是"在前 1200 个字符里"——
    // 分支里每加一颗方法，那种定长窗口就会莫名其妙地红一次。
    const shellBlock = preloadSource.slice(preloadSource.indexOf('if (IS_SHELL)'))
    expect(shellBlock).toMatch(/exposeInMainWorld\('airshipShell'/)
    expect(preloadSource.indexOf('if (IS_SHELL)')).toBeLessThan(preloadSource.indexOf("exposeInMainWorld('airshipShell'"))
  })
})
