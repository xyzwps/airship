#!/usr/bin/env node
/**
 * airship 应用安装器生成器（仓库内驱动）—— 把 dist-apps/<id>.airship 裹成一枚每用户 setup.exe。
 *
 * 流水本身住在 @airship/cli（src/cli/lib/installer.mjs），外部作者与这里跑的是同一份；
 * 这个文件只做仓库特有的三件事：
 *   - 名单与版本：应用清单来自 code/app-dirs.mjs，版本读 src/apps/<id>/package.json；
 *   - makensis：用 electron-builder 缓存里那份（just build-runtime 第一次会下载它）；
 *   - 落点：release/apps/ 与产物同名 .sha256。
 *
 * 契约在 src/apps/specs/package.md（PK-031 ~ PK-035）。措辞全部从 @airship/contract 烘进脚本，
 * 图标取包根那份 icon.ico（PK-036），安装器不再自己转——转图标只发生在 code/pack-app.mjs。
 *
 * 用法：node code/make-app-installer.mjs <id>    只出那一个（`just app-installer <id>` 会先产它的包再调它）
 *       node code/make-app-installer.mjs         不给 id 就出全部，名单与产包同源（code/app-dirs.mjs）
 * 产物：release/apps/<id>-Setup-<版本>.exe + 同名 .sha256。
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appIds, SRC_APPS } from './app-dirs.mjs'
import { APP_ID_PATTERN, PACKAGE_SUFFIX } from '@airship/contract'
import { buildInstaller, installerScript, nsisText } from '@airship/cli/installer'

export { installerScript, nsisText }

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

/** makensis 用 electron-builder 缓存里那份：nsis-<版本>/<hash>/Bin/makensis.exe */
function findMakensisInCache() {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache')
  const hint = '先跑一次 just build-runtime（electron-builder 会下载 NSIS 到缓存），再回来产应用安装器。'
  if (!existsSync(cache)) throw new Error(`找不到 electron-builder 的缓存目录。${hint}`)
  for (const dir of readdirSync(cache)) {
    if (!dir.startsWith('nsis-') || dir.startsWith('nsis-resources')) continue
    const root = join(cache, dir)
    for (const sub of readdirSync(root)) {
      const p = join(root, sub)
      if (!statSync(p).isDirectory()) continue
      for (const candidate of [join(p, 'Bin', 'makensis.exe'), join(p, 'makensis.exe')]) {
        if (existsSync(candidate)) return candidate
      }
    }
  }
  throw new Error(`electron-builder 缓存里没有 makensis。${hint}`)
}

/** 一个应用的安装器：读那份归档的版本与落点规矩，流水交给 @airship/cli */
function installerFor(id) {
  const appPkgPath = join(SRC_APPS, id, 'package.json')
  if (!existsSync(appPkgPath)) throw new Error(`没有这个应用：src/apps/${id}/package.json 不在`)
  const version = JSON.parse(readFileSync(appPkgPath, 'utf8')).version

  const archive = join(repo, 'dist-apps', `${id}${PACKAGE_SUFFIX}`)
  if (!existsSync(archive)) throw new Error(`没有 ${id} 的包：先跑 just build-apps`)

  buildInstaller({
    archivePath: archive,
    version,
    publisher: 'xyzwp',
    outDir: join(repo, 'release', 'apps'),
    makensis: findMakensisInCache(),
    log: (line) => console.log(line)
  })
}

async function cli() {
  // 不给 id 就是全部应用：名单与 just build-apps 同源（code/app-dirs.mjs），
  // 所以 just build 出来的包与安装器必然是一批东西，不会一个八个、一个七个。
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'))
  if (wanted.length > 1) {
    throw new Error('用法：node code/make-app-installer.mjs [<id>]（不给 id 就是全部应用，一次一个请走 just app-installer <id>）')
  }
  if (wanted.length === 1 && !APP_ID_PATTERN.test(wanted[0])) {
    throw new Error('用法：node code/make-app-installer.mjs <id>（id 要是小写字母开头的那一档形状）')
  }
  const ids = wanted.length === 1 ? wanted : appIds()
  if (ids.length === 0) throw new Error('src/apps 下一个完整的应用都没有（名单判据见 code/app-dirs.mjs）')
  if (ids.length > 1) console.log(`产 ${ids.length} 枚应用安装器 → release/apps`)
  for (const id of ids) installerFor(id)
}

// 直接跑就进 CLI，被用例 import 就不动（与 pack-app.mjs 同一个做法）。
const selfPath = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(selfPath)
if (invokedDirectly) {
  try {
    await cli()
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    process.exitCode = 1
  }
}
