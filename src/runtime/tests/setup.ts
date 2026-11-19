import { join } from 'node:path'
import { registerPackageAt } from '../main/services/packageRegistry'
import { packageArchivesIn, packageFixtureRoot, writeFixturePackages } from './helpers/packages'

/**
 * 用例的公共工装。
 *
 * 两件地基都在这里铺：
 *
 *   1. `matchMedia` 的假实现——jsdom 没有它，而主题模块用它判"跟随系统"落在亮还是暗
 *      （这条本身是 TH 册子的一条契约）。用例改 `globalThis.__prefersDark` 就能换系统偏好，
 *      不用碰产品代码。
 *   2. **一张装着真清单的活动包表**。runtime 只跑命令行指来的包（不扫磁盘），
 *      用例也就照着注册来喂：把仓库真清单落成归档，再逐个注册进表。
 *      没有这一步，`grants`、`paths`、`windows` 这些直接问注册表的用例全会空。
 *
 * 落包的做法只在 `helpers/packages.ts` 一处。这里曾经也留过一份内联实现，
 * 两份并存时包根里是目录、用例读的是归档——注册表"安静地空着"，
 * 报出来的是一句"未知的应用 id"，看不出工装坏在哪一侧。这种空不是失败，是最难查的那种红。
 *
 * 这里只 import packageRegistry（不碰 electron）：setup 跑在测试文件的 vi.mock('electron')
 * 生效之前，引到 appRegistry 那条链（logging → paths → electron）就会拿到真 electron 而炸。
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

// 包表先铺好：任何用例问到注册表之前，仓库真清单已经落成归档并逐个注册进表。
// 注册失败必须响亮——空表不算通过（这条教训原来钉在 AP-008，现在落在工装自己身上）。
const fixtureRoot = writeFixturePackages(packageFixtureRoot())
for (const name of packageArchivesIn(fixtureRoot)) {
  const { problems } = registerPackageAt(join(fixtureRoot, name))
  if (problems.length > 0) throw new Error(`工装包注册失败 ${name}：${problems.join('；')}`)
}
