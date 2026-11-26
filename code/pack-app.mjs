#!/usr/bin/env node
/**
 * airship 产包器（仓库内适配层）—— 把一个已构建好的产物目录装成 `<id>.airship`。
 *
 * 流水本身住在 @airship/cli（src/cli/lib/pack.mjs），外部作者与这里跑的是同一份判据，
 * 也包括同一份 `icon.ico`：它存在应用目录里、由构建搬进产物目录，产包期不转格式。
 *
 * 判据只有 @airship/contract 那一份：从前"Node 解不开本仓 TS 所以两侧各写一遍、用例钉相等"
 * 的局面随 contract 的 dist 一起退场了。下面的旧名导出只是给用例与 build-apps.mjs 留接口。
 *
 * 用法：
 *   node code/pack-app.mjs --src <产物目录> --manifest <manifest.json> --out <包根目录>
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
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

/** 产一个包：流水在 @airship/cli，仓库这一层只是它的入口——图标随应用目录备好了进来 */
export function pack(options) {
  return packPackage(options)
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
