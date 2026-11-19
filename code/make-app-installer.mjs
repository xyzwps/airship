#!/usr/bin/env node
/**
 * airship 应用安装器生成器 —— 把 dist-apps/<id>.airship 裹成一个每用户的 setup.exe。
 *
 * 契约在 src/apps/specs/package.md（PK-031 ~ PK-035）：
 *   - 找 runtime 按 AIRSHIP_PATH > C:\Program Files\airship\runtime 的顺序（与 tools.ts 同一套语义）；
 *   - 装进 %LOCALAPPDATA%\airship\apps\<id>\，不要管理员；
 *   - 装前念能力清单，措辞从 @airship/contract 烘进脚本（单一真源，不在 NSI 里另写一份）；
 *   - 桌面快捷方式目标 "<runtime>\airship.exe"，参数 "<安装目录>\<id>.airship"，两段都带引号；
 *   - 卸载删安装目录与快捷方式，不碰 %APPDATA% 里的设置与数据。
 *
 * 用法：node code/make-app-installer.mjs <id>    只出那一个（`just app-installer <id>` 会先产它的包再调它）
 *       node code/make-app-installer.mjs         不给 id 就出全部，名单与产包同源（code/app-dirs.mjs）
 * 产物：release/apps/<id>-Setup-<版本>.exe + 同名 .sha256。版本读 src/apps/<id>/package.json。
 *
 * makensis 用 electron-builder 缓存里那份（不引新依赖）；快捷方式那份多尺寸 .ico 不再自己转，
 * 直接取归档里产包期派生的那一份（PK-036）——图标只有一处生成，就是 code/pack-app.mjs。
 *
 * 这个 .mjs 直接 import @airship/contract：Node 24 的类型剥离吃得下契约包
 * （它内部相对 import 都带扩展名）。措辞与 id 形状因此只有一份，不用像产包器那样两边各写再钉相等。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import { appIds, SRC_APPS } from './app-dirs.mjs'
import {
  APP_ID_PATTERN,
  MANIFEST_NAME,
  PACKAGE_SUFFIX,
  WINDOWS_ICON_NAME,
  installConfirmDetail,
  installConfirmMessage,
  runtimeNotFound
} from '@airship/contract'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))

/** NSIS 字符串转义：$ → $$、双引号 → $"、换行 → $\n（先转 $，后两条引入的 $ 不再回转） */
export function nsisText(text) {
  return text.replace(/\$/g, '$$$$').replace(/"/g, '$\\"').replace(/\r/g, '').replace(/\n/g, '$\\n')
}

/**
 * 生成安装脚本（纯函数，用例钉的就是这份文本）。
 * 能力措辞在这里烘进去：installConfirmMessage / installConfirmDetail / runtimeNotFound
 * 全部来自契约层，脚本里不另写一份人话。
 * 界面走 MUI2 向导（欢迎 / 进度 / 完成 + 卸载三页，简中+英文）：欢迎页念安装目录，
 * 进度页不刷日志，完成页点「完成」直接关窗。能力确认仍是 .onInit 里那张 MessageBox（PK-033）。
 */
export function installerScript({ id, name, version, capabilities }) {
  const displayName = nsisText(name)
  const confirm = nsisText(`${installConfirmMessage(name)}\n\n${installConfirmDetail(capabilities)}`)
  const notFound = nsisText(runtimeNotFound())
  const archiveName = `${id}${PACKAGE_SUFFIX}`
  const regKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\airship-${id}`
  return `; 由 code/make-app-installer.mjs 生成，别手改；措辞生成时从 @airship/contract 烘进。
Unicode true
Name "${displayName}"
OutFile "${id}-Setup-${version}.exe"
; 每用户安装（PK-035）：不提权，落点在 $LOCALAPPDATA 下
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\\airship\\apps\\${id}"

; ---- MUI2 向导（2026-11-19：安装过程美观些）----
; 欢迎页念安装目录，进度页干净不刷日志，完成页点「完成」直接关窗（不带「运行」勾选）。
; 图标用包内那张转成的 icon.ico（与快捷方式同一张）；简中在前作默认语言。
!include "MUI2.nsh"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${displayName}"
!define MUI_WELCOMEPAGE_TEXT "${displayName} 要装到这台机器上。$\\r$\\n$\\r$\\n安装目录：$INSTDIR$\\r$\\n$\\r$\\n装完在桌面与开始菜单各留一枚快捷方式，双击它就用 airship runtime 打开这个应用。$\\r$\\n$\\r$\\n点「下一步」继续。"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"
ShowInstDetails nevershow
ShowUninstDetails nevershow

Var RuntimeDir

Function .onInit
  ; 装前念能力清单（PK-033）：取消就中止，一个文件都不写。/SD IDOK 只服务静默安装。
  MessageBox MB_OKCANCEL "${confirm}" /SD IDOK IDOK install_ok
  Abort
  install_ok:
  ; 找 runtime（PK-031）：AIRSHIP_PATH > 固定目录；环境变量指不到就落到固定目录再试。
  ReadEnvStr $0 "AIRSHIP_PATH"
  StrCmp $0 "" try_fixed
  IfFileExists "$0\\airship.exe" 0 try_fixed
  StrCpy $RuntimeDir $0
  Goto found
  try_fixed:
  StrCpy $0 "$PROGRAMFILES64\\airship\\runtime"
  IfFileExists "$0\\airship.exe" 0 not_found
  StrCpy $RuntimeDir $0
  Goto found
  not_found:
  MessageBox MB_OK "${notFound}" /SD IDOK
  Abort
  found:
FunctionEnd

Section "install"
  SetOutPath "$INSTDIR"
  File "${archiveName}"
  File "icon.ico"
  WriteUninstaller "$INSTDIR\\uninstall.exe"
  ; 快捷方式（PK-032）：目标是 runtime 的 airship.exe，参数是归档绝对路径，两段都带引号；
  ; 图标用包内那张转成的 .ico，不是 runtime 的。
  CreateShortcut "$DESKTOP\\${displayName}.lnk" "$RuntimeDir\\airship.exe" '"$INSTDIR\\${archiveName}"' "$INSTDIR\\icon.ico"
  CreateShortcut "$SMPROGRAMS\\${displayName}.lnk" "$RuntimeDir\\airship.exe" '"$INSTDIR\\${archiveName}"' "$INSTDIR\\icon.ico"
  ; 每用户的卸载项（HKCU，不要管理员）
  WriteRegStr HKCU "${regKey}" "DisplayName" "${displayName}"
  WriteRegStr HKCU "${regKey}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${regKey}" "Publisher" "xyzwp"
  WriteRegStr HKCU "${regKey}" "DisplayIcon" "$INSTDIR\\icon.ico"
  WriteRegStr HKCU "${regKey}" "UninstallString" '"$INSTDIR\\uninstall.exe"'
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\\${displayName}.lnk"
  Delete "$SMPROGRAMS\\${displayName}.lnk"
  DeleteRegKey HKCU "${regKey}"
  ; 只删安装目录（PK-034）：设置与数据在别的目录，这里一个字节都不碰。
  RMDir /r "$INSTDIR"
SectionEnd
`
}

/** 取归档里产包期派生的那份 icon.ico（PK-036）：快捷方式与安装目录用的就是它 */
function extractWindowsIcon(bytes, work) {
  const entry = unzipSync(bytes, { filter: (f) => f.name === WINDOWS_ICON_NAME })[WINDOWS_ICON_NAME]
  if (!entry) {
    throw new Error(`包里缺 ${WINDOWS_ICON_NAME}：先跑 just build-apps 重产包（它从包根那张源图派生这一份，PK-036）`)
  }
  const ico = join(work, WINDOWS_ICON_NAME)
  writeFileSync(ico, entry)
  return ico
}

/** makensis 用 electron-builder 缓存里那份：nsis-<版本>/<hash>/Bin/makensis.exe */
function findMakensis() {
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

/** 一个应用的安装器：读那份归档、抽包内 ico、跑 makensis、落 release/apps/ 并写 .sha256 */
function installerFor(id) {
  const appPkgPath = join(SRC_APPS, id, 'package.json')
  if (!existsSync(appPkgPath)) throw new Error(`没有这个应用：src/apps/${id}/package.json 不在`)
  const version = JSON.parse(readFileSync(appPkgPath, 'utf8')).version

  const archive = join(repo, 'dist-apps', `${id}${PACKAGE_SUFFIX}`)
  if (!existsSync(archive)) throw new Error(`没有 ${id} 的包：先跑 just build-apps`)
  const bytes = new Uint8Array(readFileSync(archive))
  const manifestEntry = unzipSync(bytes, { filter: (f) => f.name === MANIFEST_NAME })[MANIFEST_NAME]
  if (!manifestEntry) throw new Error(`${id}${PACKAGE_SUFFIX} 里没有 ${MANIFEST_NAME}，先重产包`)
  const manifest = JSON.parse(strFromU8(manifestEntry))
  if (manifest.id !== id) throw new Error(`包清单的 id 是 ${manifest.id}，与 ${id} 对不上`)

  const work = mkdtempSync(join(tmpdir(), 'airship-installer-'))
  try {
    extractWindowsIcon(bytes, work)
    copyFileSync(archive, join(work, `${id}${PACKAGE_SUFFIX}`))
    writeFileSync(
      join(work, 'installer.nsi'),
      installerScript({ id, name: manifest.name, version, capabilities: manifest.capabilities }),
      'utf8'
    )
    const makensis = findMakensis()
    const res = spawnSync(makensis, ['/INPUTCHARSET', 'UTF8', '/V2', 'installer.nsi'], { cwd: work, stdio: 'inherit' })
    if (res.status !== 0) throw new Error('makensis 出包失败')

    const outName = `${id}-Setup-${version}.exe`
    const produced = join(work, outName)
    if (!existsSync(produced)) throw new Error(`makensis 说成功却没有 ${outName}`)
    const outDir = join(repo, 'release', 'apps')
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, outName)
    // 宁可没有，不可有旧的：同名旧包先删（与 clean-installer 同一条规矩）
    rmSync(target, { force: true, maxRetries: 5, retryDelay: 250 })
    copyFileSync(produced, target)
    const sha = createHash('sha256').update(readFileSync(target)).digest('hex')
    writeFileSync(`${target}.sha256`, `${sha}  ${outName}\n`, 'utf8')
    console.log(`已产安装器 release/apps/${outName}`)
    console.log(`SHA256 ${sha}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
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