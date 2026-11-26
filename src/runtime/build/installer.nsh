; runtime 的安装落点钉死（2026-11-26 改到每用户主目录）：%USERPROFILE%\.airship\runtime。
; 装的是自己那一份，不要管理员（perMachine: false，PK-035）；
; customInit 插在 initMultiUser（按 perMachine 给 $INSTDIR 赋值）之后，所以这里的覆盖生效；
; allowToChangeInstallationDirectory: false 去掉换目录页，这一行就是目录的唯一真源。
;
; 但只写这一行不够（2026-11-26 实测踩到）：辅助向导的安装模式页在前置函数里跑
; setInstallModePerUser（multiUser.nsh），它会**重新赋值 $INSTDIR**——先读
; ${INSTALL_REGISTRY_KEY}（= HKCU\Software\<由 appId 派生的 guid>）的 InstallLocation，读不到就用默认位置
; $LOCALAPPDATA\Programs\airship。它在 customInit 之后跑，于是欢迎页念的是
; ~\.airship\runtime、文件却整份落进 AppData\Local\Programs\airship。
; 所以把它要读的那条值一起钉上：这条注册表键本来就是模板记安装路径用的
; （include/installer.nsh 装完会写 InstallLocation $INSTDIR），这里只是提前写成固定值，
; 升级与历史都不作数——"一定装在这个目录下"由这两句一起成立。
!macro customInit
  StrCpy $INSTDIR "$PROFILE\.airship\runtime"
  WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation" "$PROFILE\.airship\runtime"
!macroend

; 只留"当前用户"那一档（2026-11-26）：辅助向导在 perMachine: false 下恒定插一页
; "为所有用户 / 仅为当前用户"的选择页（assistedInstaller.nsh 的 PAGE_INSTALL_MODE），
; 而 allowElevation: false 只是把那颗键禁用并补一句英文 "must run as admin"，页面照旧。
; 模板里那个钩子写了两样拼写——闸门 !ifmacrodef customInstallmode、插入 !insertmacro customInstallMode，
; 但 NSIS 的宏名不区分大小写，它们是同一个宏：定义两遍 makensis 直接报 "macro already exists"，只留一份。
; 拍上 $isForceCurrentInstall 之后页面前置函数直接 setInstallModePerUser + Abort：
; 那一页不出现，也不会去 UAC_RunElevated。否则选了"所有用户"就是文件落 $PROFILE、卸载项写 HKLM 的分裂结果。
; 注意这一页正是 $INSTDIR 被改回默认位置的地方（见上面 customInit 的注），所以那条注册表值必须一起钉。
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; 欢迎页把固定安装目录念给人看（2026-11-19：安装过程要能查看安装路径）。
; 目录仍钉死、不给改（allowToChangeInstallationDirectory: false，PK-035）——
; 这一页只是"告诉你装哪"，不是换目录页。$INSTDIR 由上面的 customInit 钉成固定路径，
; 欢迎页显示时它已经赋好值。MUI2 由 electron-builder 的 installer.nsi 先 include。
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "安装 airship runtime"
  !define MUI_WELCOMEPAGE_TEXT "airship runtime 是你这个用户的运行时：装一次，你手上的所有应用共用它（不要管理员）。$\r$\n$\r$\n安装目录（固定，不可更改）：$\r$\n$INSTDIR$\r$\n$\r$\n应用由各自的安装器装进同一棵树里的 apps\<id>；双击应用快捷方式时，由这里的 airship.exe 把它跑起来。$\r$\n$\r$\n点「下一步」开始安装。"
  !insertmacro MUI_PAGE_WELCOME
!macroend