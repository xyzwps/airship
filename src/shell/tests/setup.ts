/**
 * 用例的公共工装。
 *
 * jsdom 不提供 matchMedia，而壳的主题模块用它判断"跟随系统"到底落在亮还是暗
 * （这条本身是 TH 册子的一条契约）。这里补一个可控的假实现：
 * 用例改 `globalThis.__prefersDark` 就能换系统偏好，不用碰产品代码。
 */

const g = globalThis as unknown as {
  window?: { matchMedia?: (q: string) => MediaQueryList }
  __prefersDark: boolean
}

g.__prefersDark = false

if (typeof g.window !== 'undefined' && !g.window.matchMedia) {
  g.window.matchMedia = (query: string): MediaQueryList => {
    const dark = /prefers-color-scheme:\s*dark/.test(query) ? g.__prefersDark : false
    return {
      matches: dark,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false
    } as MediaQueryList
  }
}
