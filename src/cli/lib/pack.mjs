/**
 * `@airship/cli` 的产包核心——把一个**已经构建好**的产物目录装成一个 airship 包：
 * 校验 → 摊平成条目表 → 备好 icon.ico → zipSync → 写 `<id>.airship`（就是个 zip 换了扩展名）。
 *
 * 判据**只有 `@airship/contract` 那一份**：产包侧与 runtime 注册侧调的是同一批函数，
 * 从前"Node 解不开本仓 TS 所以两侧各写一遍、用例钉相等"的局面随 contract 的 dist 一起退场了。
 * 这里只剩盘上动作与 PK-007 那条纪律（暂存后改名，失败一个字节都不留）。
 *
 * `icon.ico` 的两条路：
 *   - 仓库内：`code/pack-app.mjs` 传 `makeWindowsIcon`，由包根那张源图派生（resvg + Pillow，PK-036）；
 *   - 仓库外：产物目录里**自备** `icon.ico`，缺了响亮失败（PK-039）——不静默降级成"任务栏穿 runtime 的图标"。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import {
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  WINDOWS_ICON_NAME,
  entryOf,
  packageLayoutProblems,
  packageManifestProblems,
  referenceProblems
} from '@airship/contract'

/**
 * 改名带重试：Windows 上刚写完的目录常被 Defender 或资源管理器索引短暂占用，
 * 一次 rename 会拿 EPERM。这里不吞错误——试满三轮还是不成就照原样抛，
 * 让调用方看到包没装上而不是好像装上了。
 */
export function renameWithRetry(from, to, attempts = 3) {
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

/**
 * 把产物目录摊平成 zip 的条目表：条目名是包内的相对路径（正斜杠），值是字节。
 *
 * 源目录里那份 `manifest.json` 被丢掉——包根写的是校验过的那一份，
 * 不是产物目录里可能存在的任何草稿。
 */
export function collectEntries(dir, prefix = '') {
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
export function packPackage({ srcDir, outRoot, manifestText, manifest: manifestIn, makeWindowsIcon }) {
  const source = resolve(srcDir)
  const root = resolve(outRoot)
  if (!existsSync(source)) throw new Error(`产物目录不存在：${source}`)
  mkdirSync(root, { recursive: true })

  let manifest = manifestIn
  if (manifest === undefined) {
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
  }

  const problems = packageManifestProblems(manifest)
  if (problems.length > 0) throw new Error(`包清单不合格：\n${problems.join('\n')}`)

  const entries = collectEntries(source)

  // PK-004 / PK-038：入口、图标、后端入口都要真在产物里
  const layout = packageLayoutProblems(manifest, Object.keys(entries))
  if (layout.length > 0) throw new Error(`包不合格：\n${layout.join('\n')}`)

  // PK-036 / PK-039：包根那份外壳图标。在写盘之前备好——
  // 拿不到图标时旧包一个字节都没动，包根里也不留半成品（与 PK-007 同一条纪律）。
  if (typeof makeWindowsIcon === 'function') {
    const sourceIcon = Object.keys(entries).find((n) => !n.includes('/') && /^icon\.(svg|png|jpe?g|webp)$/.test(n))
    entries[WINDOWS_ICON_NAME] = makeWindowsIcon(sourceIcon, entries[sourceIcon])
  } else if (!(WINDOWS_ICON_NAME in entries)) {
    throw new Error(
      `包根没有 ${WINDOWS_ICON_NAME}：任务栏与快捷方式那颗外壳图标只认磁盘上的 .ico。` +
        `请把一张多尺寸（16~256）的 icon.ico 放进产物目录再产包——` +
        `它不算第二张图标，包根那张源图（icon.svg / png / jpg / jpeg / webp）仍要在`
    )
  }

  // PK-006：入口文档的引用一条都不许指到包外
  const entry = entryOf(manifest)
  const refs = referenceProblems(readFileSync(join(source, entry), 'utf8'))
  if (refs.length > 0) throw new Error(`包不合格：\n${refs.join('\n')}`)

  const id = manifest.id
  const finalFile = join(root, `${id}${PACKAGE_SUFFIX}`)
  const staging = join(root, `${id}${PACKAGE_SUFFIX}.tmp-${process.pid}-${Date.now()}`)
  const backup = join(root, `${id}${PACKAGE_SUFFIX}.prev-${Date.now()}`)
  let movedOld = false

  try {
    entries[MANIFEST_NAME] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`)
    // 9 档：包是发出去的文件，体积比产包快慢更要紧（实测八个包合起来比目录小一半左右）
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
