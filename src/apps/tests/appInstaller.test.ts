import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { installerScript, nsisText } from '../../../code/make-app-installer.mjs'
import { BACKEND_PHRASE, capabilitiesPhrase, runtimeNotFound } from '@airship/contract'
import { REAL_APPS } from '../../runtime/tests/helpers/realApps'

/**
 * PK-031 ~ PK-035：应用安装器生成出来的那份 NSIS 脚本里读得到的判据。
 *
 * 真装一遍、快捷方式真双击归真机走查（just app-installer airship-life-game）；
 * 这里钉的是生成器的纯函数输出：找 runtime 的顺序、落点、快捷方式命令行、
 * 能力措辞（与契约层逐字一致）、卸载带走什么、两个安装器都装进 ~/.airship 且都不提权。
 */

const REPO = join(__dirname, '..', '..', '..')
const game = REAL_APPS.find((m) => m.id === 'airship-life-game')!
const ffmpeg = REAL_APPS.find((m) => m.id === 'airship-ffmpeg')!

function scriptOf(meta: (typeof REAL_APPS)[number]): string {
  return installerScript({ id: meta.id, name: meta.name, version: '0.0.0-test', capabilities: meta.capabilities })
}

describe('安装器找 runtime', () => {
  it('PK-031 找 runtime 按顺序，找不到念原话不装', () => {
    const script = scriptOf(game)
    // AIRSHIP_PATH 在前，固定目录在后（与 tools.ts 同一套顺序）
    const envAt = script.indexOf('ReadEnvStr $0 "AIRSHIP_PATH"')
    const fixedAt = script.indexOf('$PROFILE\\.airship\\runtime')
    expect(envAt).toBeGreaterThan(-1)
    expect(fixedAt).toBeGreaterThan(envAt)
    // 两处都按 airship.exe 在不在判
    expect(script.match(/IfFileExists "\$0\\airship\.exe"/g)).toHaveLength(2)
    // 找不到：念契约层那句原话（转义后烘进脚本），然后中止
    expect(script).toContain(nsisText(runtimeNotFound()))
    const notFoundAt = script.indexOf('not_found:')
    expect(script.indexOf('Abort', notFoundAt)).toBeGreaterThan(notFoundAt)
  })
})

describe('装完留下什么', () => {
  it('PK-032 落点与快捷方式的命令行', () => {
    const script = scriptOf(game)
    expect(script).toContain('InstallDir "$PROFILE\\.airship\\apps\\airship-life-game"')
    expect(script).toContain('SetOutPath "$INSTDIR"')
    expect(script).toContain('File "airship-life-game.airship"')
    // 目标与参数两段都带引号；图标是包内那张转的 .ico
    expect(script).toContain(
      `CreateShortcut "$DESKTOP\\${game.name}.lnk" "$RuntimeDir\\airship.exe" '"$INSTDIR\\airship-life-game.airship"' "$INSTDIR\\icon.ico"`
    )
    expect(script).toContain('File "icon.ico"')
  })

  it('PK-033 装之前念能力清单（并进欢迎页，不再弹窗）', () => {
    const script = scriptOf(ffmpeg)
    expect(script).toContain(nsisText(`它要的能力：${capabilitiesPhrase(ffmpeg.capabilities)}`))

    // 空清单念的是「不碰你的文件」；每个应用的措辞都与契约层逐字一致（烘进，不另写）
    const gameScript = scriptOf(game)
    expect(gameScript).toContain(nsisText('它要的能力：不碰你的文件'))
    for (const meta of REAL_APPS) {
      expect(scriptOf(meta), `${meta.id} 的能力措辞与契约层分叉了`).toContain(
        nsisText(`它要的能力：${capabilitiesPhrase(meta.capabilities)}`)
      )
    }

    // 包根带 backend.js（hasBackend 由调用方从归档条目读出来）：末尾多念一句后台，不占能力位
    const backendScript = installerScript({ id: 'demo', name: '示范', version: '0.0.0-test', capabilities: [], hasBackend: true })
    expect(backendScript).toContain(nsisText(`它要的能力：${capabilitiesPhrase([], true)}`))
    expect(backendScript).toContain(nsisText(BACKEND_PHRASE))
  })
})

describe('卸载带走什么', () => {
  it('PK-034 卸载删归档留数据', () => {
    const script = scriptOf(game)
    const uninstall = script.slice(script.indexOf('Section "Uninstall"'))
    expect(uninstall).toContain(`Delete "$DESKTOP\\${game.name}.lnk"`)
    expect(uninstall).toContain('DeleteRegKey HKCU')
    expect(uninstall).toContain('RMDir /r "$INSTDIR"')
    // 设置与数据在同一棵树的 data\<id> 下：整份脚本读不到那一段路径
    expect(script).not.toMatch(/\.airship\\data|%APPDATA%|\$APPDATA/i)
  })
})

describe('两个安装器都装进 ~/.airship，都不要管理员', () => {
  it('PK-035 应用每用户不提权，runtime 每用户钉死目录', () => {
    const script = scriptOf(game)
    expect(script).toContain('RequestExecutionLevel user')
    expect(script).toContain('InstallDir "$PROFILE\\.airship\\apps\\airship-life-game"')
    // 应用安装器只往 $INSTDIR（$PROFILE\.airship\apps 下）写，不往 Program Files 写
    expect(script).not.toMatch(/SetOutPath "\$PROGRAMFILES/)

    // runtime 那份：每用户 + 固定目录的唯一真源在 installer.nsh 的 customInit
    const nsh = readFileSync(join(REPO, 'src', 'runtime', 'build', 'installer.nsh'), 'utf8')
    // 安装模式页的前置函数会重新赋值 $INSTDIR（先读这条注册表值，读不到就用默认位置），
    // 所以同一个固定路径要一起写进模板要读的那条键——否则向导念一个目录、文件落另一个目录
    const initMacro = nsh.match(/!macro customInit\r?\n([\s\S]*?)!macroend/i)
    expect(initMacro, 'installer.nsh 里没有 customInit 宏').not.toBeNull()
    expect(initMacro![1]).toContain('StrCpy $INSTDIR "$PROFILE\\.airship\\runtime"')
    expect(initMacro![1]).toContain('WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$PROFILE\\.airship\\runtime"')
    // 安装模式拍成当前用户。NSIS 宏名不区分大小写：模板里 customInstallmode / customInstallMode
    // 两样拼写是同一个宏，各定义一份会让 makensis 报 "macro already exists"，所以只许出现一次
    expect(nsh).toContain('StrCpy $isForceCurrentInstall "1"')
    expect(nsh.match(/!macro\s+custominstallmode\s*$/gim)).toHaveLength(1)
    const yml = readFileSync(join(REPO, 'src', 'runtime', 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/perMachine: false/)
    expect(yml).toMatch(/allowToChangeInstallationDirectory: false/)
    // runtime 安装包不带任何应用归档（没有 extraResources 那一档）
    expect(yml).not.toContain('extraResources')
  })
})

describe('NSIS 字符串转义', () => {
  it('PK-033 引号、换行与 $ 都转成 NSIS 的写法，措辞烘进去不走样', () => {
    expect(nsisText('a"b')).toBe('a$\\"b')
    expect(nsisText('a\nb')).toBe('a$\\nb')
    expect(nsisText('$0')).toBe('$$0')
    expect(nsisText('a\r\nb')).toBe('a$\\nb')
  })
})