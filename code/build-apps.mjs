#!/usr/bin/env node
/**
 * 逐个应用构建并产成 airship 包，落进 `dist-apps/<id>.airship/`。
 *
 *   node code/build-apps.mjs              全部六个
 *   node code/build-apps.mjs life pdf     只产这几个
 *   AIRSHIP_APPS_OUT=D:/pkgs node code/build-apps.mjs   换落点（用例与排查用）
 *
 * 为什么"每个应用各跑一次 vite build"：一次构建里放六份 html，Rollup 会把 React 抽成
 * 一份共享 chunk，六个包就互相依赖了——那正是这次要拆掉的东西。分开构建才是"一个包自带全部东西"。
 *
 * 清单从哪来：`src/apps/<id>/app.ts` 是 TS，而 Node 跑不了本仓的 TS（相对 import 不带扩展名）。
 * 所以这里用 vite 的 transformWithOxc 把类型抹掉，再 import 那份纯数据，
 * 序列化进包根的 `manifest.json`。**清单的真源仍然是 app.ts**，包内那份是它的投影；
 * 同一轮构建同时产出投影与文档，两者不可能对不上号。
 *
 * 中间产物（构建输出与抹掉类型的清单）都写在系统临时目录，只有包本身进 dist-apps/。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, transformWithOxc } from 'vite'
import { pack, SCHEMA_VERSION } from './pack-app.mjs'

process.env.VITE_CONFIG_NATIVE_IGNORE_WARNING = 'true'

const ROOT = resolve(import.meta.dirname, '..')
const SRC_APPS = join(ROOT, 'src', 'apps')
const CONFIG = join(ROOT, 'code', 'app.vite.config.mts')
const OUT_ROOT = resolve(process.env.AIRSHIP_APPS_OUT ?? join(ROOT, 'dist-apps'))
const SDK_VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

/** 应用目录的判据：清单、入口文档、入口脚本、一张图标，四样齐了才算一个应用 */
function appDirs() {
  return readdirSync(SRC_APPS)
    .filter((name) => {
      const dir = join(SRC_APPS, name)
      if (!statSync(dir).isDirectory()) return false
      return (
        existsSync(join(dir, 'app.ts')) &&
        existsSync(join(dir, 'index.html')) &&
        existsSync(join(dir, 'main.tsx')) &&
        readdirSync(dir).some((n) => /^icon\.(svg|png|jpe?g|webp)$/.test(n))
      )
    })
    .sort()
}

/** app.ts → 包清单：抹掉类型、import 那份纯数据、补上包格式的三个字段 */
async function readManifest(dirId, work) {
  const source = readFileSync(join(SRC_APPS, dirId, 'app.ts'), 'utf8')
  const { code } = await transformWithOxc(source, `${dirId}/app.ts`, { loader: 'ts', format: 'esm' })
  const flat = join(work, `${dirId}.app.mjs`)
  writeFileSync(flat, code, 'utf8')
  const mod = await import(pathToFileURL(flat).href)
  const meta = mod.app
  if (!meta) throw new Error(`src/apps/${dirId}/app.ts 没导出 app`)
  return { ...meta, schemaVersion: SCHEMA_VERSION, sdkVersion: SDK_VERSION }
}

function dirBytes(dir) {
  let total = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) total += dirBytes(p)
    else total += statSync(p).size
  }
  return total
}

async function buildOne(dirId, work) {
  const built = join(work, `built-${dirId}`)
  mkdirSync(built, { recursive: true })

  process.env.AIRSHIP_APP_ID = dirId
  process.env.AIRSHIP_APP_OUT = built
  await build({
    configFile: CONFIG,
    // 配置里 import 的是本仓的 .ts（sdk 的 CSP 那一份真源），只有 bundle 装载器解得了。
    // 显式写 bundle 只是意图；vite 8 仍旧按 native 检查并刷屏警告，所以把那声也按下——
    // 六次构建刷六遍同一句没意义，而它说的'未来默认换 native'到时是 vite 升级要处理的事。
    configLoader: 'bundle',
    logLevel: 'warn',
    // inline 覆盖 file config：六个应用连着构建时，不能指望上一份的环境变量还没被复用
    root: join(SRC_APPS, dirId),
    base: './',
    build: { outDir: built, emptyOutDir: true }
  })

  // 图标是文件约定，不是 html 里的引用，vite 不会替我们搬——自己放进包根
  const icon = readdirSync(join(SRC_APPS, dirId)).find((n) => /^icon\.(svg|png|jpe?g|webp)$/.test(n))
  cpSync(join(SRC_APPS, dirId, icon), join(built, icon))

  const manifest = await readManifest(dirId, work)
  const { file } = pack({ srcDir: built, outRoot: OUT_ROOT, manifestText: JSON.stringify(manifest, null, 2) })
  // 归档大小与归档内那堆产物的字节一起报：前者是发出去的分发物，
  // 后者是"一个包自带全部东西"（含自己那份 React）的真实体积
  const packed = Math.round(statSync(file).size / 1024)
  const raw = dirBytes(built)
  console.log(
    `  ${dirId.padEnd(8)} ${String(packed).padStart(5)} KB（归档内 ${Math.round(raw / 1024)} KB）→ ${basename(file)}`
  )
}

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  const dirs = appDirs()
  if (dirs.length === 0) throw new Error(`src/apps 下一个完整的应用都没有（要 app.ts + index.html + main.tsx + 一张 icon.*）`)
  const picked = wanted.length > 0 ? dirs.filter((d) => wanted.includes(d)) : dirs
  const missing = wanted.filter((w) => !dirs.includes(w))
  if (missing.length > 0) throw new Error(`这些应用不存在或不完整：${missing.join(', ')}（在 src/apps 里有的：${dirs.join(', ')}）`)

  mkdirSync(OUT_ROOT, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'airship-build-'))
  console.log(`产 ${picked.length} 个包 → ${OUT_ROOT}`)
  try {
    for (const dirId of picked) await buildOne(dirId, work)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exitCode = 1
})
