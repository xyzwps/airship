#!/usr/bin/env node
/**
 * 应用名单的唯一判据：一个目录要同时有 `app.ts` + `index.html` + `main.tsx` + 一张 `icon.*` 才算一个应用。
 *
 * 为什么单独一个文件：产包（`build-apps.mjs`）与产安装器（`make-app-installer.mjs`）都要这份名单。
 * 判据在两处各写一遍，就会出"包产了八个、安装器只裹了七个"那种对不上的发布物——
 * 而 `just build` 现在一条命令出两样，这种分叉没人能在肉眼比对里抓到。
 *
 * 只许 Node 直接加载，所以本仓 TS 那套"相对 import 带扩展名"的规矩在这里不适用（它就是 .mjs）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 应用都住在这一层下（`templates/app` 是范本，不参与名单） */
export const SRC_APPS = join(resolve(import.meta.dirname, '..'), 'src', 'apps')

const ICON_PATTERN = /^icon\.(svg|png|jpe?g|webp)$/

/** 完整应用的 id，按字典序（与产包的顺序一致） */
export function appIds(srcApps = SRC_APPS) {
  return readdirSync(srcApps)
    .filter((name) => isAppDir(join(srcApps, name)))
    .sort()
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
