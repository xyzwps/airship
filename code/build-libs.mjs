#!/usr/bin/env node
/**
 * 把两份要发布的包编成 JS + d.ts：@airship/contract 与 @airship/sdk。
 *
 * 为什么仓内也要这一步：npm 的 publishConfig 不会改写 exports（实测：tarball 里
 * package.json 原样带着源码路径），所以"发布物吃 dist"与"仓内解析"只能是同一份
 * exports——指到 dist，仓内就先把 dist 编出来。just 把顺序钉死（build-libs 是
 * compile / build-apps / typecheck / test 的前置），不靠人记得住。
 *
 * 两份都用 rewriteRelativeImportExtensions 把源码里"带 .ts 扩展名的相对 import"
 * 改写成 .js——那条规矩（Node 解不开省略扩展名的源码包）在这两处是同一件事的两面。
 * SDK 的 CSS 不是 TS 编得动的：原样拷进 dist/styles/，host.js 里那条 import 指的就是它。
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
// 用当前 node 直接跑 tsc 的入口：Windows 上 spawn 一个 .cmd 需要 shell（Node 的 EINVAL 规矩），
// 而 build-libs 是要被 just 依赖的每一步都过的路，不该留这种平台岔口
const TSC_ENTRY = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const TARGETS = [
  { pkg: '@airship/contract', dir: join(ROOT, 'src', 'shared', 'contract') },
  { pkg: '@airship/sdk', dir: join(ROOT, 'src', 'sdk') }
]

for (const { pkg, dir } of TARGETS) {
  const dist = join(dir, 'dist')
  // 先清 dist：删不掉的"已消失文件的旧编译物"会在发布物里躺着冒充新包——同一条出包纪律
  rmSync(dist, { recursive: true, force: true })
  const r = spawnSync(process.execPath, [TSC_ENTRY, '-p', join(dir, 'tsconfig.build.json')], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`${pkg} 编译失败（退出码 ${r.status}）`)
    process.exit(1)
  }
  for (const probe of ['index.js', 'index.d.ts']) {
    if (!existsSync(join(dist, probe))) {
      console.error(`${pkg} 编译完却没有 dist/${probe}——构建配置与入口对不上`)
      process.exit(1)
    }
  }
}

// SDK 的样式不是编译物，是随包的文件：拷过去，exports 的 ./styles.css 指的就是这份
const stylesTo = join(TARGETS[1].dir, 'dist', 'styles')
mkdirSync(stylesTo, { recursive: true })
cpSync(join(TARGETS[1].dir, 'styles', 'airship.css'), join(stylesTo, 'airship.css'))

console.log('build-libs：contract 与 sdk 的 dist 已就位')
