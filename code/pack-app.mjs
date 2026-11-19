#!/usr/bin/env node
/**
 * airship 产包器 —— 把一个**已经构建好**的应用产物目录装成一个 airship 包：
 * 校验 → 摊平成条目表 → zipSync → 写 `<id>.airship`（就是个 zip 换了扩展名）。
 *
 * 契约的唯一叙述在 `src/apps/specs/package.md`（PK-001 ~ PK-007，加上 PK-036 那份派生图标）；这个文件只管三件事：
 * 校字段形状、拷文件（含把包根那张源图转成外壳认的 `icon.ico`）、暂存后改名。它不构建应用（构建是应用自己的事），
 * 也不判定能力名——那份规矩在 `src/shared/contract/registryRules.ts` 只有一处，runtime 侧运行期再判一次。
 *
 * 读它的那一侧在 src/runtime/main/services/packageArchive.ts：fflate 的 unzipSync 带 filter，
 * 只解要用的那一个条目，不整包展开。
 *
 * 用法：
 *   node code/pack-app.mjs --src <产物目录> --manifest <manifest.json> --out <包根目录>
 *
 * 为什么产包器是 .mjs 而规矩在 .ts：Node 跑不了这仓库的 TS（相对 import 不带扩展名，
 * 实测 ERR_MODULE_NOT_FOUND），所以 id 形状这条两边各写一遍，
 * 并由 `src/apps/tests/package.test.ts` 把两份正则钉成完全相等——
 * 靠人记着同步是会分叉的，靠用例不会。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { strFromU8, strToU8, zipSync } from 'fflate'
import { Resvg } from '@resvg/resvg-js'

/** 仓库根：code/ 的上一层。用文件路径算，不认 cwd */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')

/** 归档文件名的后缀：`<id>` + 这个（一个 zip，换了扩展名） */
export const PACKAGE_SUFFIX = '.airship'

/** runtime 只认这一档包格式；写别的产包期就拒 */
export const SCHEMA_VERSION = 1

/** 包清单的文件名，在包根 */
export const MANIFEST_NAME = 'manifest.json'

/**
 * 与 src/shared/app.ts 的 APP_ID_PATTERN 同一条（用例钉相等）。
 * 为什么只挡这一批字符：实测下来 id 进 URL 段与进 Windows 目录名，
 * 会坏的就四类——`#`/`?` 截断、`%` 让校验值与落盘值分叉、NTFS 非法字符、空白；
 * 全小写顺带把大小写折叠的撞名（实测 EEXIST）也消掉了。
 * 界面显示名在 name 字段，那里不限字符。
 */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** 图标仍是文件约定，不进清单（AP-007 的同一理由） */
const ICON_PATTERN = /^icon\.(svg|png|jpe?g|webp)$/

/**
 * 包根那份派生的 Windows 外壳图标（PK-036，与 src/shared/contract/packageRules.ts 同一份规矩，
 * 由 src/apps/tests/package.test.ts 钉两处相等）。
 * 它不是第二张图标：外壳只读磁盘上的 .ico，不认归档里的路径。
 */
export const WINDOWS_ICON_NAME = 'icon.ico'

/** 包清单允许的键：应用自己的事实 + 包格式的三个字段 */
const ALLOWED_KEYS = [
  'id',
  'name',
  'description',
  'capabilities',
  'sharedNamespaces',
  'flush',
  'defaultWidth',
  'defaultHeight',
  'platforms',
  'tools',
  'schemaVersion',
  'sdkVersion',
  'entry'
]

/** 被明确驳回过的表现字段，出现在清单里要指名说为什么不行 */
const REJECTED_KEYS = ['iconPath', 'icon', 'order']

/** 入口 html 里要扫的引用 */
const REFERENCE_PATTERN = /(?:src|href)\s*=\s*["']([^"']+)["']/g

/** 放行但不需要落在包内的引用前缀 */
const INLINE_PROTOCOLS = /^(data:|blob:)/i

/**
 * 改名带重试：Windows 上刚写完的目录常被 Defender 或资源管理器索引短暂占用，
 * 一次 rename 会拿 EPERM。这里不吞错误——试满三轮还是不成就照原样抛，
 * 让调用方看到包没装上而不是好像装上了。
 */
function renameWithRetry(from, to, attempts = 3) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      renameSync(from, to)
      return
    } catch (e) {
      if (i === attempts - 1 || !['EPERM', 'EACCES'].includes(e?.code)) throw e
      sleepSync(120 * (i + 1))
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isPlainObject(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** PK-001：id 的形状。返回值是要给人读的那一句 */
export function idShapeProblem(id) {
  if (typeof id !== 'string' || id === '') return '包清单缺 id，或 id 不是字符串'
  if (!APP_ID_PATTERN.test(id)) {
    return (
      `id "${id}" 不合形状：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符` +
      `（id 同时是包目录名、数据目录名与 airship:// 地址里的一段，这几处对字符都有硬性要求；` +
      `界面显示名写在 name 字段，那里不限字符）`
    )
  }
  return null
}

/** PK-002 / PK-003：包清单的字段形状。能力名与工具名不在这里判 */
export function manifestProblems(manifest) {
  if (!isPlainObject(manifest)) return ['包清单必须是一个 JSON 对象']
  const out = []

  const shape = idShapeProblem(manifest.id)
  if (shape) out.push(shape)

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    out.push(
      `包清单 schemaVersion 只认 ${SCHEMA_VERSION}，收到 ${JSON.stringify(manifest.schemaVersion)}` +
        `（包格式与 runtime 不同档时别硬装，先对齐 runtime 的版本）`
    )
  }
  if (typeof manifest.sdkVersion !== 'string' || manifest.sdkVersion.trim() === '') {
    out.push('包清单缺 sdkVersion：写构建这个包时用的 SDK 版本，例如 "1.0.0"')
  }
  for (const key of ['name', 'description']) {
    if (typeof manifest[key] !== 'string' || manifest[key].trim() === '') {
      out.push(`包清单 ${key} 必须是非空字符串，收到 ${JSON.stringify(manifest[key])}`)
    }
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.some((c) => typeof c !== 'string')) {
    out.push('包清单 capabilities 必须是字符串数组，用不到就写空数组')
  }
  if (manifest.entry !== undefined && typeof manifest.entry !== 'string') {
    out.push(`包清单 entry 不写就等于 index.html，写了必须是字符串，收到 ${JSON.stringify(manifest.entry)}`)
  }
  for (const key of ['defaultWidth', 'defaultHeight']) {
    const v = manifest[key]
    if (v !== undefined && (!Number.isInteger(v) || v <= 0)) {
      out.push(`包清单 ${key} 必须是正整数像素值，收到 ${JSON.stringify(v)}`)
    }
  }
  for (const key of REJECTED_KEYS) {
    if (key in manifest) {
      out.push(
        `包清单里不写 ${key}：图标是包根那一张文件（icon.svg / png / jpg / jpeg / webp），` +
          `显示顺序由 runtime 按名字典序定，两者都不是应用自己能决定的`
      )
    }
  }
  for (const key of Object.keys(manifest)) {
    if (!ALLOWED_KEYS.includes(key)) out.push(`包清单有 runtime 不认的键 "${key}"（要么拼错，要么包格式与 runtime 不同档）`)
  }
  return out
}

/** PK-004 / PK-005：入口在不在包里，图标是不是恰好一张 */
export function layoutProblems({ fileNames, manifest }) {
  const out = []
  const entry = typeof manifest.entry === 'string' && manifest.entry ? manifest.entry : 'index.html'
  if (!fileNames.includes(entry)) {
    out.push(`包里没有入口文件 ${entry}（清单 entry 指的就是它在包根的名字）`)
  }

  const icons = fileNames.filter((n) => ICON_PATTERN.test(n))
  if (icons.length === 0) {
    out.push('包里缺图标 icon.svg（也接受 png / jpg / jpeg / webp），一张都要有')
  } else if (icons.length > 1) {
    out.push(`包里的图标有多张，只留一张：${icons.join(', ')}`)
  }
  return out
}

/** PK-006：入口 html 的引用必须落在包内，一条都不许指到包外 */
export function referenceProblems(html) {
  const out = []
  for (const matched of html.matchAll(REFERENCE_PATTERN)) {
    const ref = matched[1]
    if (ref === undefined) continue
    const value = ref.trim()
    if (value === '' || value.startsWith('#')) continue
    if (INLINE_PROTOCOLS.test(value)) continue
    if (/^\/\//.test(value)) {
      out.push(`入口里有一条协议相对的外部引用 ${value}：包必须自带全部东西，装到机器上不能依赖网络`)
      continue
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      out.push(`入口里有一条外部引用 ${value}：包必须自带全部东西，装到机器上不能依赖网络`)
      continue
    }
    if (value.startsWith('/')) {
      out.push(`入口里有一条绝对路径引用 ${value}：它相对的是盘符而不是包，换成包内的相对路径`)
      continue
    }
    let depth = 0
    for (const segment of value.split('/')) {
      if (segment === '..') depth -= 1
      else if (segment !== '' && segment !== '.') depth += 1
      if (depth < 0) break
    }
    if (depth < 0) {
      out.push(`入口里有一条越出包根的引用 ${value}：包里的东西只能在包内互相引用`)
    }
  }
  return out
}

function fileNamesIn(dir) {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile())
}

/**
 * 包根那张源图 → 多尺寸 `.ico` 的字节（PK-036）。
 *
 * SVG 先经 @resvg/resvg-js 渲染成 256 宽 PNG（Pillow 不认 SVG 是本机事实），
 * 再交 code/app-ico.py（Pillow）出 16~256 各档。中间文件落在系统临时目录的一个新目录里，用完就删。
 * 转不出来就抛：任务栏那颗按钮的图标要靠它，产包不静默降级成"外壳用 runtime 的图标"。
 * `@resvg/resvg-js` 是静态 import——产包全程同步（PK-007 那条"暂存后改名"不容异步插队）。
 */
export function windowsIconBytes(iconName, raw) {
  const work = mkdtempSync(join(tmpdir(), 'airship-ico-'))
  try {
    let raster
    if (iconName.endsWith('.svg')) {
      raster = join(work, 'icon.png')
      writeFileSync(raster, new Resvg(strFromU8(raw), { fitTo: { mode: 'width', value: 256 } }).render().asPng())
    } else {
      raster = join(work, iconName)
      writeFileSync(raster, raw)
    }
    const ico = join(work, WINDOWS_ICON_NAME)
    // 成功时不刷屏（Pillow 那句"已生成…"在 GBK 控制台下是乱码），失败时把它的报错原样交出来
    const py = spawnSync('python', [join(REPO, 'code', 'app-ico.py'), raster, ico], {
      stdio: ['ignore', 'ignore', 'inherit']
    })
    if (py.status !== 0) {
      throw new Error(`图标转 .ico 失败（python code/app-ico.py，退出码 ${py.status}）：任务栏图标靠这一份，产包不降级`)
    }
    return readFileSync(ico)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 把产物目录摊平成 zip 的条目表：条目名是包内的相对路径（正斜杠），值是字节。
 *
 * 源目录里那份 `manifest.json` 被丢掉——包根写的是校验过、补全过默认值的那一份，
 * 不是产物目录里可能存在的任何草稿。
 */
function collectEntries(dir, prefix = '') {
  const out = {}
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const at = prefix ? `${prefix}/${name}` : name
    if (statSync(p).isDirectory()) {
      Object.assign(out, collectEntries(p, at))
      continue
    }
    if (!prefix && name === MANIFEST_NAME) continue
    out[at] = readFileSync(p)
  }
  return out
}

/**
 * 产一个包：**zip 归档，扩展名 `.airship`**。
 *
 * PK-007：先写 `<id>.airship.tmp-<pid>-<时间戳>` 再改名成正式名。
 * 中途任何一步失败，旧包原样还在，包根里不留半成品——
 * 半成的归档被扫到只会得到"读不出来"，比没有更糟。
 */
export function pack({ srcDir, outRoot, manifestText }) {
  const source = resolve(srcDir)
  const root = resolve(outRoot)
  if (!existsSync(source)) throw new Error(`产物目录不存在：${source}`)
  mkdirSync(root, { recursive: true })

  let manifest
  const file = join(source, MANIFEST_NAME)
  const text = manifestText ?? (existsSync(file) ? readFileSync(file, 'utf8') : null)
  if (text === null) {
    throw new Error(`${MANIFEST_NAME} 不存在：既没在产物目录 ${source} 里找到，也没用 --manifest 指定`)
  }
  try {
    manifest = JSON.parse(text)
  } catch (e) {
    throw new Error(`${MANIFEST_NAME} 解析失败：${e.message}`)
  }

  const problems = manifestProblems(manifest)
  if (problems.length > 0) throw new Error(`包清单不合格：\n${problems.join('\n')}`)

  const entry = typeof manifest.entry === 'string' && manifest.entry ? manifest.entry : 'index.html'
  const entryFile = join(source, entry)
  if (!existsSync(entryFile)) {
    const layout = layoutProblems({ fileNames: fileNamesIn(source), manifest })
    throw new Error(`包不合格：\n${layout.join('\n')}`)
  }
  const refs = referenceProblems(readFileSync(entryFile, 'utf8'))
  if (refs.length > 0) throw new Error(`包不合格：\n${refs.join('\n')}`)

  const layout = layoutProblems({ fileNames: fileNamesIn(source), manifest })
  if (layout.length > 0) throw new Error(`包不合格：\n${layout.join('\n')}`)

  // PK-036：包根那张源图另存一份外壳认得的 .ico。在写盘之前转——
  // 转换失败时旧包一个字节都没动，包根里也不留半成品（与 PK-007 同一条纪律）。
  const sourceIcon = fileNamesIn(source).find((n) => ICON_PATTERN.test(n))
  const icoBytes = windowsIconBytes(sourceIcon, readFileSync(join(source, sourceIcon)))

  const id = manifest.id
  const finalFile = join(root, `${id}${PACKAGE_SUFFIX}`)
  const staging = join(root, `${id}${PACKAGE_SUFFIX}.tmp-${process.pid}-${Date.now()}`)
  const backup = join(root, `${id}${PACKAGE_SUFFIX}.prev-${Date.now()}`)
  let movedOld = false

  try {
    const entries = collectEntries(source)
    entries[MANIFEST_NAME] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
    entries[WINDOWS_ICON_NAME] = icoBytes
    // 9 档：包是发出去的文件，体积比产包快慢更要紧（实测六个包合起来比目录小一半左右）
    writeFileSync(staging, zipSync(entries, { level: 9 }))

    if (existsSync(finalFile)) {
      renameWithRetry(finalFile, backup)
      movedOld = true
    }
    renameWithRetry(staging, finalFile)
    if (movedOld) rmSync(backup, { recursive: true, force: true })
  } catch (e) {
    rmSync(staging, { force: true })
    // 旧包被挪走过就必须挪回来：失败的装包不许把一个好好的包留在看不见的位置
    if (movedOld && !existsSync(finalFile) && existsSync(backup)) renameWithRetry(backup, finalFile)
    throw e
  }

  return { file: finalFile, manifest }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--src') out.srcDir = argv[++i]
    else if (arg === '--out') out.outRoot = argv[++i]
    else if (arg === '--manifest') out.manifestPath = argv[++i]
    else throw new Error(`不认识的参数：${arg}（产包器只吃 --src / --manifest / --out）`)
  }
  return out
}

function cli() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.srcDir || !args.outRoot) {
    throw new Error('用法：node code/pack-app.mjs --src <产物目录> --manifest <manifest.json> --out <包根目录>')
  }
  const manifestText = args.manifestPath ? readFileSync(resolve(args.manifestPath), 'utf8') : undefined
  const { file } = pack({ srcDir: resolve(args.srcDir), outRoot: resolve(args.outRoot), manifestText })
  console.log(`已产包 ${file}`)
}

// 直接跑就进 CLI，被用例 import 就不动。认自己的文件路径，不认 cwd——
// 拿 cwd 拼路径来判的话，从别的目录跑就会一声不响地什么都不做。
const selfPath = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(selfPath)
if (invokedDirectly) {
  try {
    cli()
  } catch (e) {
    // 报人读的那几句，别把调用栈混在中间——这个输出是要在 just 的日志里看得清的
    console.error(String(e instanceof Error ? e.message : e))
    process.exitCode = 1
  }
}
