/**
 * 出包自检（对应 wslc-desktop 的 `just verify-installer`）。
 *
 * 看六件事，都是"能自己验就不留给你踩"：
 *   1. release/ 里有没有对应 src/runtime/package.json 版本号的安装包；
 *   2. 它像不像一个 Windows 安装程序（PE 的 MZ 头 + NSIS 的 NullsoftInst 签名）；
 *   3. 旁边那份 .sha256 写好了没（发给客户防传输被改）；
 *   4. 免安装的 win-unpacked 里主 exe 在不在（打包链路完整性的旁证）；
 *   5. 安装包是不是纯 runtime——resources/ 里不该有任何 airship 包；
 *   6. runtime 自己的产物里不该有渲染目标，也不该再留着启动器通道（合回去了就是走回头路）。
 */
import { createHash } from 'node:crypto'
import { unzipSync } from 'fflate'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
// 版本号的真源是 runtime 那个包：安装包文件名与 exe 的文件版本都从它的 package.json 来
const pkg = JSON.parse(readFileSync(join(repo, 'src', 'runtime', 'package.json'), 'utf8'))
const release = join(repo, 'release')

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(release)) fail('还没有 release/ 目录，先跑 just build-runtime')

const exes = readdirSync(release).filter((n) => /^airship-runtime-Setup-.*-x64\.exe$/.test(n))
if (exes.length === 0) fail('release/ 里没有安装包，先跑 just build-runtime')

const expected = `airship-runtime-Setup-${pkg.version}-x64.exe`
if (!exes.includes(expected)) fail(`没有版本 ${pkg.version} 的安装包，release/ 里是：${exes.join(', ')}`)

const file = join(release, expected)
const bytes = readFileSync(file)
if (bytes.subarray(0, 2).toString('latin1') !== 'MZ') fail(`${expected} 不是 PE 可执行文件（缺 MZ 头）`)
// NSIS 的签名不在文件头：实测在这台产物里落在 10 万字节的偏移上，所以整块找
if (!bytes.includes('NullsoftInst')) fail(`${expected} 里没有 NSIS 签名，可能不是安装向导`)

const sha256 = createHash('sha256').update(bytes).digest('hex')
const sidecar = `${file}.sha256`
writeFileSync(sidecar, `${sha256}  ${expected}\n`, 'utf8')

// 主 exe 的名字来自 productName（airship）——应用快捷方式的目标就是它，按名字钉死
const unpacked = join(release, 'win-unpacked', 'airship.exe')
const unpackedDir = join(release, 'win-unpacked')
const unpackedExe = existsSync(unpacked)
  ? unpacked
  : existsSync(unpackedDir)
    ? readdirSync(unpackedDir).find((n) => n.endsWith('.exe'))
    : null

const sizeMb = (statSync(file).size / 1024 / 1024).toFixed(1)
console.log(`✓ 安装包   release/${expected}  ${sizeMb} MB`)
console.log(`✓ SHA256   ${sha256}`)
console.log(`✓ 校验文件 ${expected}.sha256`)
console.log(`✓ 免安装   ${unpackedExe ? 'win-unpacked 里有主 exe' : 'win-unpacked 缺主 exe（不影响 setup.exe）'}`)

/* ---------------- 5. 安装包必须是纯 runtime ----------------
 *
 * 2026-11-07 定的分发模型：安装包只装 runtime，一个应用都不带；应用是 airship 包，
 * 由应用自己的安装器落到每用户目录。所以这条要反过来钉——只要 resources/airship-apps 又出现了
 * （比如有人把 extraResources 那一档加回去），就是走回头路。
 */
const appsDir = existsSync(unpackedDir) ? join(unpackedDir, 'resources', 'airship-apps') : null
if (appsDir && existsSync(appsDir)) {
  const carried = readdirSync(appsDir).filter((n) => n.endsWith('.airship'))
  fail(`安装包里不该带应用：resources/airship-apps 里有 ${carried.length} 个归档（${carried.join(', ')}）——runtime 必须是纯的`)
}

// resources/ 里除了 runtime 的 asar 与 NSIS 提权辅助件，不该再有别的东西
if (existsSync(unpackedDir)) {
  const extra = readdirSync(join(unpackedDir, 'resources')).filter((n) => n !== 'app.asar' && n !== 'elevate.exe')
  if (extra.length > 0) fail(`resources/ 里多了不该有的东西：${extra.join(', ')}`)
}
console.log('✓ 纯 runtime resources/ 里只有 app.asar 与 elevate.exe，没带任何应用')

/* ---------------- 6. 旁证：runtime 的产物里没有渲染目标与启动器通道 ----------------
 *
 * 反向检查两条：out/renderer 整个目录不该存在（runtime 不画自己的界面，应用文档走包协议）；
 * out/main 与 out/preload 的产物里不该再出现 launcher: 通道或 airshipShell 字样——
 * 启动器那一族退场之后，它们留在产物里就是有人把旧面合回去了。
 */
const outDir = join(repo, 'src', 'runtime', 'out')
if (existsSync(join(outDir, 'renderer'))) fail('runtime 的产物里还有 out/renderer：runtime 不该有自己的渲染目标')
const leaked = []
for (const side of ['main', 'preload']) {
  const dir = join(outDir, side)
  if (!existsSync(dir)) continue
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(join(dir, name), 'utf8')
    if (text.includes('launcher:') || text.includes('airshipShell')) leaked.push(`${side}/${name}`)
  }
}
if (leaked.length > 0) fail(`runtime 的产物里还留着启动器面：${leaked.join(', ')}`)
console.log('✓ 产物     out/ 里没有 renderer，主进程与 preload 里没有启动器通道')

