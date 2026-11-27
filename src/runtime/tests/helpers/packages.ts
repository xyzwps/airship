import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { DEFAULT_ENTRY, MANIFEST_NAME, PACKAGE_BACKEND_ENTRY, PACKAGE_SUFFIX, WINDOWS_ICON_NAME } from '@airship/contract'
import { REAL_APPS, manifestOf } from './realApps'
import type { AppMeta } from '@airship/contract'

/**
 * 用例的包工装。
 *
 * 产品代码只跑命令行指来的包（`services/packageRegistry.ts` 的活动包表），用例也就照着注册来喂：
 * 把仓库里的真清单原样落成 `<id>.airship` 归档（清单 + 入口 html + 一张图标 + 一个 assets 条目），
 * 放进系统临时目录；注册进表那一步在 `setup.ts`（每个用例文件开局逐个 registerPackageAt）。
 *
 * 两条刻意的选择：
 *   1. **清单内容不造假**。用例读到的尺寸、两份名单、平台就是 `app.ts` 里那一份——
 *      改了清单，这些用例跟着变，不会出现"测试里的 vcp 和产品里的 vcp 不是同一个东西"。
 *   2. 归档里**不放任何应用代码**。runtime 的册子钉的是 runtime 的判定；
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

/** 包根那张源图（PK-004 只认 icon.png）：注册判据不看字节，PNG 签名这段就够 */
const ICON_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 包根那份 Windows 外壳图标（PK-036）在用例里的样子。
 *
 * 外壳不参与用例，所以这里放的是一段够短的假字节：
 * 用例钉的是"落盘那份与包内那份逐字节相同"（SH-034），与图标画的是什么无关。
 */
const WINDOWS_ICON_BYTES = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0])

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
 * 往某个包根里装一个包：清单、入口文档、一张图标（点名要后台就再带上包根那份 backend.js）。
 * 只补形状，不改清单——清单里写了什么，落盘就是什么。
 */
export function installPackageAt(root: string, meta: AppMeta & { id: string }, opts?: { backend?: boolean }): string {
  const entries: Record<string, string | Uint8Array> = {
    [MANIFEST_NAME]: `${JSON.stringify(manifestOf(meta), null, 2)}\n`,
    [DEFAULT_ENTRY]: ENTRY_HTML,
    'icon.png': ICON_PNG,
    [WINDOWS_ICON_NAME]: WINDOWS_ICON_BYTES,
    'assets/index.js': 'export default 1\n'
  }
  // 后端条目在用例包里的样子：报就绪 + 回声。外壳进程不参与用例，
  // 真消息行为由 backend.test.ts 的假进程钉；这里只管"包根有那个条目就有后台"的形状（PK-040）。
  if (opts?.backend) entries[PACKAGE_BACKEND_ENTRY] = BACKEND_STUB
  return writeArchive(join(root, `${meta.id}${PACKAGE_SUFFIX}`), entries)
}

/** 后端入口在用例包里的样子：够注册与落盘判据用的报就绪脚本 */
export const BACKEND_STUB = 'process.parentPort.postMessage({ ready: true })\n'

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
    'icon.png': ICON_PNG
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
