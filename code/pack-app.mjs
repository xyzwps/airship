#!/usr/bin/env node
/**
 * airship 产包器（仓库内适配层）—— 把一个已构建好的产物目录装成 `<id>.airship`。
 *
 * 流水本身住在 @airship/cli（src/cli/lib/pack.mjs），外部作者与这里跑的是同一份判据；
 * 这个文件只做仓库特有的那一件事：包根那张源图派生出 `icon.ico`（PK-036，
 * resvg 渲 PNG + code/app-ico.py 出多尺寸 ico）。仓库外是作者自备（PK-039），
 * 两条路都是 packPackage 的 `makeWindowsIcon` 钩子的不同取值。
 *
 * 判据只有 @airship/contract 那一份：从前"Node 解不开本仓 TS 所以两侧各写一遍、用例钉相等"
 * 的局面随 contract 的 dist 一起退场了。下面的旧名导出只是给用例与 build-apps.mjs 留接口。
 *
 * 用法：
 *   node code/pack-app.mjs --src <产物目录> --manifest <manifest.json> --out <包根目录>
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { strFromU8 } from 'fflate'
import { Resvg } from '@resvg/resvg-js'
import { packPackage } from '@airship/cli/pack'
import {
  APP_ID_PATTERN,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  SCHEMA_VERSION,
  WINDOWS_ICON_NAME,
  idShapeProblem,
  isInsidePackagePath,
  packageLayoutProblems,
  packageManifestProblems,
  referenceProblems
} from '@airship/contract'

// 旧导出名留给用例与 build-apps.mjs——判据就是契约那一份，不再有两份要钉相等。
export {
  APP_ID_PATTERN,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  SCHEMA_VERSION,
  WINDOWS_ICON_NAME,
  idShapeProblem,
  isInsidePackagePath,
  referenceProblems
}
export const manifestProblems = (manifest) => packageManifestProblems(manifest)
export const layoutProblems = ({ fileNames, manifest }) => packageLayoutProblems(manifest, fileNames)

/** 仓库根：code/ 的上一层。用文件路径算，不认 cwd */
const REPO = resolve(fileURLToPath(import.meta.url), '..', '..')

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

/** 产一个包：流水在 @airship/cli，这里只把仓库那份图标派生法接进去 */
export function pack(options) {
  return packPackage({ ...options, makeWindowsIcon: windowsIconBytes })
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
