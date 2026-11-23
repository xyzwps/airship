/**
 * 读应用清单：`app.ts` 是 TS，Node 不吃本仓那种带 `.ts` 扩展名的相对 import——
 * 但清单是**纯数据**，用 vite 的 transformWithOxc 把类型抹掉就能直接 import 那份投影。
 *
 * 这条路与仓库内 `code/build-apps.mjs` 读的完全一样：范本复制出去之后，
 * 清单的真源仍是应用目录里的 `app.ts`，包内 `manifest.json` 只是它的投影。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { SCHEMA_VERSION } from '@airship/contract'

/** 这个项目装的 @airship/sdk 是哪一版——包清单的 sdkVersion 就该念哪一版（同一次构建，不许说谎） */
export function installedSdkVersion() {
  const requireFromHere = createRequire(import.meta.url)
  try {
    const pkgFile = requireFromHere.resolve('@airship/sdk/package.json')
    return JSON.parse(readFileSync(pkgFile, 'utf8')).version
  } catch {
    throw new Error('读不到 @airship/sdk 的版本：产包的项目里要先装上 @airship/sdk（npm i @airship/sdk）')
  }
}

/** app.ts → 包清单：抹掉类型、import 那份纯数据、补上包格式的两个字段 */
export async function readAppManifest({ appTs, workDir, sdkVersion }) {
  const { transformWithOxc } = await import('vite')
  const source = readFileSync(appTs, 'utf8')
  const { code } = await transformWithOxc(source, appTs, { loader: 'ts', format: 'esm' })
  const flat = join(workDir, `app-${process.pid}-${Date.now()}.mjs`)
  writeFileSync(flat, code, 'utf8')
  const mod = await import(pathToFileURL(flat).href)
  const meta = mod.app
  if (!meta) throw new Error(`${appTs} 没导出 app`)
  return { ...meta, schemaVersion: SCHEMA_VERSION, sdkVersion: sdkVersion ?? installedSdkVersion() }
}

/** 找应用目录里的清单源文件：app.ts 优先，app.mjs / app.js 也认（纯 JS 项目不必碰 TS 工具链） */
export function findAppManifestFile(appDir) {
  for (const name of ['app.ts', 'app.mjs', 'app.js']) {
    const p = join(appDir, name)
    if (existsSync(p)) return p
  }
  return null
}
