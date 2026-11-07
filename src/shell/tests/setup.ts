import { packageFixtureRoot, writeFixturePackages } from './helpers/packages'

/**
 * 用例的公共工装。
 *
 * 两件地基都在这里铺：
 *
 *   1. `matchMedia` 的假实现——jsdom 没有它，而主题模块用它判"跟随系统"落在亮还是暗
 *      （这条本身是 TH 册子的一条契约）。用例改 `globalThis.__prefersDark` 就能换系统偏好，
 *      不用碰产品代码。
 *   2. **一个真的包根**。壳现在运行期扫包才认应用，没有包根就没有任何应用，
 *      `grants`、`paths`、`windows` 这些直接问注册表的用例全会空。
 *
 * 落包的做法只在 `helpers/packages.ts` 一处。这里曾经也留过一份内联实现，
 * 两份并存时包根里是目录、用例读的是归档——注册表"安静地空着"，
 * 报出来的是一句"未知的应用 id"，看不出工装坏在哪一侧。这种空不是失败，是最难查的那种红。
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

// 包根先铺好：任何用例问到注册表之前，AIRSHIP_APPS_ROOT 已经指到一个装着归档的目录
process.env.AIRSHIP_APPS_ROOT = writeFixturePackages(packageFixtureRoot())
