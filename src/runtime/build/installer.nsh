; runtime 的安装落点钉死（2026-11-26 改到每用户主目录）：%USERPROFILE%\.airship\runtime。
; 装的是自己那一份，不要管理员（perMachine: false，PK-035）；
; customInit 插在 initMultiUser（按 perMachine 给 $INSTDIR 赋值）之后，所以这里的覆盖生效；
; allowToChangeInstallationDirectory: false 去掉换目录页，这一行就是目录的唯一真源。
; 升级时 initMultiUser 会先读注册表里的旧 InstallLocation，同样被这里覆盖——
; "一定装在这个目录下"不向历史让步。
!macro customInit
  StrCpy $INSTDIR "$PROFILE\.airship\runtime"
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