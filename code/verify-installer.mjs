/**
 * 出包自检（对应 wslc-desktop 的 `just verify-installer`）。
 *
 * 看四件事，都是"能自己验就不留给你踩"：
 *   1. release/ 里有没有对应 package.json 版本号的安装包；
 *   2. 它像不像一个 Windows 安装程序（PE 的 MZ 头 + NSIS 的 NullsoftInst 签名）；
 *   3. 旁边那份 .sha256 写好了没（发给客户防传输被改）；
 *   4. 免安装的 win-unpacked 里主 exe 在不在（打包链路完整性的旁证）。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const release = join(repo, 'release')

const fail = (message) => {
  console.error(`✗ ${message}`)
  process.exit(1)
}

if (!existsSync(release)) fail('还没有 release/ 目录，先跑 npm run dist')

const exes = readdirSync(release).filter((n) => /^airship-Setup-.*-x64\.exe$/.test(n))
if (exes.length === 0) fail('release/ 里没有安装包，先跑 npm run dist')

const expected = `airship-Setup-${pkg.version}-x64.exe`
if (!exes.includes(expected)) fail(`没有版本 ${pkg.version} 的安装包，release/ 里是：${exes.join(', ')}`)

const file = join(release, expected)
const bytes = readFileSync(file)
if (bytes.subarray(0, 2).toString('latin1') !== 'MZ') fail(`${expected} 不是 PE 可执行文件（缺 MZ 头）`)
// NSIS 的签名不在文件头：实测在这台产物里落在 10 万字节的偏移上，所以整块找
if (!bytes.includes('NullsoftInst')) fail(`${expected} 里没有 NSIS 签名，可能不是安装向导`)

const sha256 = createHash('sha256').update(bytes).digest('hex')
const sidecar = `${file}.sha256`
writeFileSync(sidecar, `${sha256}  ${expected}\n`, 'utf8')

const unpacked = join(release, 'win-unpacked', `${pkg.name ?? 'airship'}.exe`)
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
