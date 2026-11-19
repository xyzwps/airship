/**
 * 出包前清场：删掉 release/ 里上一次留下的安装包。
 *
 * 为什么必须有这一步：安装包的文件名只由 src/runtime/package.json 的 version 决定，版本号不动
 * 就等于新旧两次出包写的是同一个名字。于是任何一次"没重写安装包"的运行都会让上一次
 * 那颗继续躺在原地，看起来像刚出的 —— 实测踩的就是这个：
 *   12:33 dist 出包 → 17:36 换墨读图标 → 17:40 只跑了解包那条（--dir，天生不产安装包）
 *   → release/ 里那颗 12:33 的 exe 还含着旧 icon.png，装完自然还是旧图标。
 * 而 verify-installer 按名字匹配、只验 PE 头与 NSIS 签名，旧包在它那里全绿，
 * 还会顺手把 .sha256 重写成旧包的哈希，连旁证一起撒谎。
 *
 * 规矩：release/ 里的安装包永远等于最后一次构建 —— 宁可没有，不可有旧的。
 * 清掉之后 verify-installer 直接报"release/ 里没有安装包，先跑 just build-runtime"，
 * 把"装错包"变成"装不上"。删掉的这颗重跑一次 dist 就回来，没什么可保的。
 *
 * 只删安装包那一族（exe / .blockmap / .sha256）。win-unpacked 留着：它是 dist 的第一步就地
 * 解包出来的目录，每次由 electron-builder 整体重写，不存在冒名顶替的问题。
 *
 * 第二档 `apps` 是同一件事的另一族：`just installers` 出全部应用的安装器之前，先把
 * `release/apps/` 里旧的那一批删掉。名单是会变的——应用删了、或某个应用这轮没产出来，
 * 它在 `release/apps/` 里留下的那枚旧 exe 一样会冒充最后一次构建。
 * 单独跑 `just app-installer <id>` 不经过这一档：它只删自己那一枚同名旧包（生成器里那条）。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const release = join(repo, 'release')

/** 安装包本体，和它那两个旁文件 */
const FAMILIES = {
  runtime: {
    dir: release,
    label: 'release/',
    pattern: /^airship-runtime-Setup-.*-x64\.exe(\.blockmap|\.sha256)?$/,
    redo: 'just build-runtime'
  },
  apps: {
    dir: join(release, 'apps'),
    label: 'release/apps/',
    pattern: /^[a-z0-9-]+-Setup-.+\.exe(\.sha256)?$/,
    redo: 'just installers'
  }
}

const which = process.argv[2] ?? 'runtime'
const family = FAMILIES[which]
if (!family) {
  console.error(`✗ 不认识要清的那一族："${which}"（只认 ${Object.keys(FAMILIES).join(' / ')}）`)
  process.exit(1)
}

if (!existsSync(family.dir)) {
  console.log(`· ${family.label}不存在，无需清场`)
  process.exit(0)
}

const stale = readdirSync(family.dir).filter((name) => family.pattern.test(name))
if (stale.length === 0) {
  console.log(`· ${family.label}里没有旧安装包`)
  process.exit(0)
}

for (const name of stale) {
  const target = join(family.dir, name)
  try {
    // Windows 上刚产出的安装包常被杀毒/索引或还活着的实例短暂占用，
    // rmSync 自带重试只吃 EPERM/EBUSY 这一类：不重试就会把"清场"变成一次看不懂的崩。
    rmSync(target, { force: true, maxRetries: 5, retryDelay: 250 })
    console.log(`✓ 清掉旧产物 ${family.label}${name}`)
  } catch (e) {
    console.error(
      `✗ 删不掉 ${family.label}${name}：${e.message}\n` +
        '  多半是上一次跑起来的飞船还活着，或安装包正被索引/杀毒占用。' +
        `关掉它再跑一次 ${family.redo}——宁可响亮报错，不许旧包冒充新包。`
    )
    process.exit(1)
  }
}
