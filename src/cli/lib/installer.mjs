/**
 * 每用户应用安装器的生成器（契约见 src/apps/specs/package.md PK-031 ~ PK-035）。
 *
 * 从产物视角看它只做四件事：读包里的清单、抽包根那份 icon.ico（取，不转——
 * 全仓没有任何地方转图标，那张 ico 与应用目录里的源图一起随包走，PK-036/PK-039）、
 * 生成 NSIS 脚本、跑 makensis。
 * 措辞（能力清单、找不到 runtime 那句）全部从 @airship/contract 烘进脚本。
 *
 * makensis 的来源是**注入的**：这台机器上 `just installers` 用 electron-builder 缓存里那份
 * （仓库的 code/make-app-installer.mjs 负责找）；外部作者按 `--makensis` > `AIRSHIP_MAKENSIS`
 * > PATH 的顺序找，找不到给装 NSIS 的指引。
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import {
  MANIFEST_NAME,
  PACKAGE_BACKEND_ENTRY,
  PACKAGE_SUFFIX,
  WINDOWS_ICON_NAME,
  capabilitiesPhrase,
  runtimeNotFound
} from '@airship/contract'

/** NSIS 字符串转义：$ → $$、双引号 → $"、换行 → $\n（先转 $，后两条引入的 $ 不再回转） */
export function nsisText(text) {
  return text.replace(/\$/g, '$$$$').replace(/"/g, '$\\"').replace(/\r/g, '').replace(/\n/g, '$\\n')
}

/**
 * 生成安装脚本（纯函数，用例钉的就是这份文本）。
 * 能力措辞在这里烘进去：capabilitiesPhrase / runtimeNotFound 全部来自契约层，脚本里不另写一份人话。
 * 后台那句念的是**包形状**（hasBackend 由调用方从归档条目读出来），不是能力位。
 * 界面走 MUI2 向导（欢迎 / 进度 / 完成 + 卸载三页，简中+英文）：欢迎页念安装目录与能力清单，
 * 进度页不刷日志，完成页点「完成」直接关窗。能力清单并进欢迎页（PK-033），不再弹 MessageBox。
 */
export function installerScript({ id, name, version, capabilities, hasBackend = false, publisher = 'airship' }) {
  const displayName = nsisText(name)
  const capsPhrase = nsisText(capabilitiesPhrase(capabilities, hasBackend))
  const notFound = nsisText(runtimeNotFound())
  const archiveName = `${id}${PACKAGE_SUFFIX}`
  const regKey = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\airship-${id}`
  return `; 由 @airship/cli 生成，别手改；措辞生成时从 @airship/contract 烘进。
Unicode true
Name "${displayName}"
OutFile "${id}-Setup-${version}.exe"
; 每用户安装（PK-035）：不提权，落点在 $LOCALAPPDATA 下
RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\\airship\\apps\\${id}"

; ---- MUI2 向导 ----
; 欢迎页念安装目录与能力清单，进度页干净不刷日志，完成页点「完成」直接关窗（不带「运行」勾选）。
; 图标用包根那份 icon.ico（与快捷方式同一张）；简中在前作默认语言。
!include "MUI2.nsh"
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "安装 ${displayName}"
!define MUI_WELCOMEPAGE_TEXT "${displayName} 要装到这台机器上。$\\r$\\n$\\r$\\n安装目录：$INSTDIR$\\r$\\n$\\r$\\n它要的能力：${capsPhrase}。$\\r$\\n$\\r$\\n装完在桌面与开始菜单各留一枚快捷方式，双击它就用 airship runtime 打开这个应用。$\\r$\\n$\\r$\\n点「下一步」继续。"
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
  ; 找不到 runtime：念契约层那句原话（转义后烘进脚本），然后中止，一个文件都不写。
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
  ; 图标用包根那份 .ico，不是 runtime 的。
  CreateShortcut "$DESKTOP\\${displayName}.lnk" "$RuntimeDir\\airship.exe" '"$INSTDIR\\${archiveName}"' "$INSTDIR\\icon.ico"
  CreateShortcut "$SMPROGRAMS\\${displayName}.lnk" "$RuntimeDir\\airship.exe" '"$INSTDIR\\${archiveName}"' "$INSTDIR\\icon.ico"
  ; 每用户的卸载项（HKCU，不要管理员）
  WriteRegStr HKCU "${regKey}" "DisplayName" "${displayName}"
  WriteRegStr HKCU "${regKey}" "DisplayVersion" "${version}"
  WriteRegStr HKCU "${regKey}" "Publisher" "${nsisText(publisher)}"
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

/** 从归档里读清单（安装器的输入是产好的包，不再判形状——包不合格根本产不出来） */
export function readArchiveManifest(archivePath) {
  const bytes = new Uint8Array(readFileSync(archivePath))
  const entry = unzipSync(bytes, { filter: (f) => f.name === MANIFEST_NAME })[MANIFEST_NAME]
  if (!entry) throw new Error(`${archivePath} 里没有 ${MANIFEST_NAME}，先重产包`)
  return JSON.parse(strFromU8(entry))
}

/** 这份包有没有自带后台：读包形状——归档根有没有 backend.js 条目（约定，不是清单字段） */
export function archiveHasBackend(archivePath) {
  const bytes = new Uint8Array(readFileSync(archivePath))
  return Object.keys(unzipSync(bytes, { filter: (f) => f.name === PACKAGE_BACKEND_ENTRY })).length > 0
}

/** 取包根那份 icon.ico（PK-036/PK-039）：快捷方式与安装目录用的就是它，全仓没有第二处转图标 */
export function extractWindowsIcon(archivePath, work) {
  const bytes = new Uint8Array(readFileSync(archivePath))
  const ico = unzipSync(bytes, { filter: (f) => f.name === WINDOWS_ICON_NAME })[WINDOWS_ICON_NAME]
  if (!ico) {
    throw new Error(
      `包里缺 ${WINDOWS_ICON_NAME}：它是应用目录里自备的那张多尺寸 ico，随源图一起进包（产包期缺了就会拦下）`
    )
  }
  const target = join(work, WINDOWS_ICON_NAME)
  writeFileSync(target, ico)
  return target
}

/** 外部机器上找 makensis：--makensis 指的路 > AIRSHIP_MAKENSIS > PATH */
export function findMakensis({ flag } = {}) {
  const candidates = []
  if (flag) candidates.push(flag)
  if (process.env.AIRSHIP_MAKENSIS) candidates.push(process.env.AIRSHIP_MAKENSIS)
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['makensis'], { encoding: 'utf8' })
  if (probe.status === 0) {
    candidates.push(...probe.stdout.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.trim()))
  }
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(
    '找不到 makensis：装一份 NSIS（例如 winget install nsis.nsis —— 或让 AI 装：「帮我安装 NSIS 并让 makensis 进 PATH」），' +
      '或用 --makensis <路径> / 环境变量 AIRSHIP_MAKENSIS 指到它。'
  )
}

/**
 * 一枚安装器的完整流水：抽图标 → 生脚本 → makensis → 落 outDir 并写 .sha256。
 *
 * makensis 由调用方给（找不到时的指引归 findMakensis）；
 * 同名旧包先删——宁可响亮报错没有，不许旧包冒充新包。
 */
export function buildInstaller({ archivePath, version, publisher, outDir, makensis, log = () => {} }) {
  const manifest = readArchiveManifest(archivePath)
  const id = manifest.id
  const work = mkdtempSync(join(tmpdir(), 'airship-installer-'))
  try {
    extractWindowsIcon(archivePath, work)
    copyFileSync(archivePath, join(work, `${id}${PACKAGE_SUFFIX}`))
    writeFileSync(
      join(work, 'installer.nsi'),
      installerScript({
        id,
        name: manifest.name,
        version,
        capabilities: manifest.capabilities,
        hasBackend: archiveHasBackend(archivePath),
        publisher
      }),
      'utf8'
    )
    const res = spawnSync(makensis, ['/INPUTCHARSET', 'UTF8', '/V2', 'installer.nsi'], { cwd: work, stdio: 'inherit' })
    if (res.status !== 0) throw new Error('makensis 出包失败')

    const outName = `${id}-Setup-${version}.exe`
    const produced = join(work, outName)
    if (!existsSync(produced)) throw new Error(`makensis 说成功却没有 ${outName}`)
    mkdirSync(outDir, { recursive: true })
    const target = join(outDir, outName)
    rmSync(target, { force: true, maxRetries: 5, retryDelay: 250 })
    copyFileSync(produced, target)
    const sha = createHash('sha256').update(readFileSync(target)).digest('hex')
    writeFileSync(`${target}.sha256`, `${sha}  ${outName}\n`, 'utf8')
    log(`已产安装器 ${target}`)
    log(`SHA256 ${sha}`)
    return { file: target, sha }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}
