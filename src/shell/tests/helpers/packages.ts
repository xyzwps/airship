import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { DEFAULT_ENTRY, MANIFEST_NAME, PACKAGE_SUFFIX } from '@airship/contract'
import { REAL_APPS, manifestOf } from './realApps'
import type { AppMeta } from '@airship/contract'

/**
 * 用例的包根工装。
 *
 * 产品代码是运行期扫包才认应用（`services/packageRegistry.ts`），用例也就照着扫包来喂：
 * 把仓库里的真清单原样落成 `<id>.airship` 归档（清单 + 入口 html + 一张图标 + 一个 assets 条目），
 * 放进系统临时目录，再把 `AIRSHIP_APPS_ROOT` 指过去。
 *
 * 两条刻意的选择：
 *   1. **清单内容不造假**。用例读到的尺寸、能力、平台就是 `app.ts` 里那一份——
 *      改了清单，这些用例跟着变，不会出现"测试里的 vcp 和产品里的 vcp 不是同一个东西"。
 *   2. 包根里**不放任何应用代码**。壳的册子钉的是壳的判定；
 *      应用真跑起来长什么样归 `just shot`（它吃 `just build-apps` 的真产物）。
 */

const ENTRY_HTML = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '  <head><meta charset="UTF-8"><title>用例包</title></head>',
  '  <body><div id="root"></div></body>',
  '</html>',
  ''
].join('\n')

const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"></svg>\n'

/**
 * 每次新开一个包根，不按 pid 复用。
 *
 * 上一版用 `airship-fixture-packages-${process.pid}` 复用同一目录，靠 `rmSync(force)` 清场——
 * Windows 上刚写下的归档常被短暂占用，`force` 把"删不掉"咽了下去，
 * 于是旧格式的残包（目录形态的 `life.airship`）留在原地：扫描拿到零个应用，还不报错。
 * `mkdtempSync`（在 `node:fs`，不是 `node:os`）每次给一个新目录，就没有这件事。
 */
let fresh: string | null = null

export function packageFixtureRoot(): string {
  // 每个用例文件是独立的模块实例，所以这是"每个文件一个新目录"：
  // 既不跨次运行复用（旧归档会留在原地），也不在同一文件里换目录（setup 与用例必须看同一个根）
  if (fresh === null) fresh = mkdtempSync(join(tmpdir(), 'airship-packages-'))
  return fresh
}

/** 把所有真清单落成包，返回包根路径 */
export function writeFixturePackages(root = packageFixtureRoot()): string {
  for (const name of readdirSync(root)) rmSync(join(root, name), { recursive: true, force: true })
  for (const meta of REAL_APPS) installPackageAt(root, meta)
  return root
}

/**
 * 往某个包根里装一个包：清单、入口文档、一张图标。
 * 只补形状，不改清单——清单里写了什么，落盘就是什么。
 */
export function installPackageAt(root: string, meta: AppMeta): string {
  return writeArchive(join(root, `${meta.id}${PACKAGE_SUFFIX}`), {
    [MANIFEST_NAME]: `${JSON.stringify(manifestOf(meta), null, 2)}\n`,
    [DEFAULT_ENTRY]: ENTRY_HTML,
    'icon.svg': ICON_SVG,
    'assets/index.js': 'export default 1\n'
  })
}

/** 写一个归档：条目名 → 内容（字符串或字节都行） */
export function writeArchive(file: string, entries: Record<string, string | Uint8Array>): string {
  mkdirSync(dirname(file), { recursive: true })
  const packed: Record<string, Uint8Array> = {}
  for (const [name, value] of Object.entries(entries)) {
    packed[name] = typeof value === 'string' ? strToU8(value) : value
  }
  writeFileSync(file, zipSync(packed, { level: 6 }))
  return file
}

/** 手写一份原样清单落包（造"坏包"判据时用：绕过 manifestOf 的补字段） */
export function installRawPackage(root: string, fileName: string, manifestText: string): string {
  return writeArchive(join(root, fileName), {
    [MANIFEST_NAME]: manifestText,
    [DEFAULT_ENTRY]: ENTRY_HTML,
    'icon.svg': ICON_SVG
  })
}

/** 包根里现在有哪些归档（造"改了名字就没了"这类判据用） */
export function packageArchivesIn(root: string): string[] {
  return readdirSync(root).filter((n) => n.endsWith(PACKAGE_SUFFIX) && statSync(join(root, n)).isFile())
}

/** 读一个归档里的某个条目（用例验包内容时用） */
export function readArchiveEntryText(file: string, name: string): string | null {
  const out = unzipSync(new Uint8Array(readFileSync(file)), { filter: (entry) => entry.name === name })
  return out[name] === undefined ? null : Buffer.from(out[name]).toString('utf8')
}
