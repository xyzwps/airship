#!/usr/bin/env node
/**
 * 应用名单的唯一判据：一个目录要同时有 `app.ts` + `index.html` + `main.tsx` + 那张 `icon.png` 才算一个应用。
 *
 * 为什么单独一个文件：产包（`build-apps.mjs`）与产安装器（`make-app-installer.mjs`）都要这份名单。
 * 判据在两处各写一遍，就会出"包产了八个、安装器只裹了七个"那种对不上的发布物——
 * 而 `just build` 现在一条命令出两样，这种分叉没人能在肉眼比对里抓到。
 *
 * 少了那张源图的目录不许安静地从名单里消失：`incompleteApps()` 把它单独列出来，
 * 出全量名单的那两个入口据此响亮失败（否则"八个应用"变成"六个"没有任何地方会念）。
 *
 * 只许 Node 直接加载，所以本仓 TS 那套"相对 import 带扩展名"的规矩在这里不适用（它就是 .mjs）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ICON_NAME, ICON_PATTERN } from '@airship/contract'

/** 应用都住在这一层下（`templates/app` 是范本，不参与名单） */
export const SRC_APPS = join(resolve(import.meta.dirname, '..'), 'src', 'apps')

/** 三份代码文件齐了却没那张源图——是应用目录，只是不合格 */
function codeFiles(dir) {
  return ['app.ts', 'index.html', 'main.tsx'].every((name) => existsSync(join(dir, name)))
}

/** 完整应用的 id，按字典序（与产包的顺序一致） */
export function appIds(srcApps = SRC_APPS) {
  return readdirSync(srcApps)
    .filter((name) => isAppDir(join(srcApps, name)))
    .sort()
}

/** 只差那张源图的应用目录，按字典序 */
export function incompleteApps(srcApps = SRC_APPS) {
  return readdirSync(srcApps)
    .filter((name) => {
      const dir = join(srcApps, name)
      return statSync(dir).isDirectory() && codeFiles(dir) && !readdirSync(dir).some((n) => ICON_PATTERN.test(n))
    })
    .sort()
}

/** 出全量名单时念的那句话：点名哪些目录少了源图，以及为什么不能默默跳过 */
export function incompleteAppsMessage(names) {
  const who = names.map((n) => `src/apps/${n}`).join('、')
  return `这些应用目录没有那张源图：${who}——源图只认 ${ICON_NAME}（svg / jpg / jpeg / webp 已退场，产包与安装期都不转格式）。补上图再出包，否则它们会从产包、安装器与截图名单里安静消失`
}

function isAppDir(dir) {
  if (!statSync(dir).isDirectory()) return false
  return (
    existsSync(join(dir, 'app.ts')) &&
    existsSync(join(dir, 'index.html')) &&
    existsSync(join(dir, 'main.tsx')) &&
    readdirSync(dir).some((n) => ICON_PATTERN.test(n))
  )
}
