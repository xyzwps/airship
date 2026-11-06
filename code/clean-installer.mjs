/**
 * 出包前清场：删掉 release/ 里上一次留下的安装包。
 *
 * 为什么必须有这一步：安装包的文件名只由 package.json 的 version 决定，版本号不动
 * 就等于新旧两次出包写的是同一个名字。于是任何一次"没重写安装包"的运行都会让上一次
 * 那颗继续躺在原地，看起来像刚出的 —— 实测踩的就是这个：
 *   12:33 dist 出包 → 17:36 换墨读图标 → 17:40 只跑了解包那条（--dir，天生不产安装包）
 *   → release/ 里那颗 12:33 的 exe 还含着旧 icon.png，装完自然还是旧图标。
 * 而 verify-installer 按名字匹配、只验 PE 头与 NSIS 签名，旧包在它那里全绿，
 * 还会顺手把 .sha256 重写成旧包的哈希，连旁证一起撒谎。
 *
 * 规矩：release/ 里的安装包永远等于最后一次构建 —— 宁可没有，不可有旧的。
 * 清掉之后 verify-installer 直接报"release/ 里没有安装包，先跑 just dist"，
 * 把"装错包"变成"装不上"。删掉的这颗重跑一次 dist 就回来，没什么可保的。
 *
 * 只删安装包那一族（exe / .blockmap / .sha256）。win-unpacked 留着：它是 dist 的第一步就地
 * 解包出来的目录，每次由 electron-builder 整体重写，不存在冒名顶替的问题。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const release = join(repo, 'release')

/** 安装包本体，和它那两个旁文件 */
const installerArtifact = /^airship-Setup-.*-x64\.exe(\.blockmap|\.sha256)?$/

if (!existsSync(release)) {
  console.log('· release/ 不存在，无需清场')
  process.exit(0)
}

const stale = readdirSync(release).filter((name) => installerArtifact.test(name))
if (stale.length === 0) {
  console.log('· release/ 里没有旧安装包')
  process.exit(0)
}

for (const name of stale) {
  const sizeMb = (statSync(join(release, name)).size / 1024 / 1024).toFixed(1)
  rmSync(join(release, name), { force: true })
  console.log(`✓ 清掉旧产物 release/${name}（${sizeMb} MB）`)
}
