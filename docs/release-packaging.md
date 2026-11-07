# 打包分发（Windows 安装包）

一条命令产出一个 `setup.exe`，拷给别人双击安装即可。**客户机不需要装 Node、不需要装 Electron。**

装完是**一个空壳**：格子里一个应用都没有（那是预期，不是坏了）。应用是 airship 包，
把 `<id>.airship` 拖到启动器上就装进 `%LOCALAPPDATA%\airship\apps`。

```bash
just build
```

产物：

| 路径 | 说明 |
|---|---|
| `release/win-unpacked/` | 免安装的散装目录（`飞船.exe` 直接双击也能跑，给自己调试用） |
| `release/airship-Setup-<版本>-x64.exe` | 安装包（纯壳），**分发只发这一个文件** |
| `dist-apps/<id>.airship` | 各应用包，另一个分发物：拖到启动器上装 |
| `release/airship-Setup-<版本>-x64.exe.sha256` | 同内容的 SHA256，发给客户防止下载/传输被改动 |
| `release/*.blockmap` / `latest.yml` | 增量更新用的旁文件，现在用不上，留着不碍事 |

## 命令速查

| 命令 | 做什么 |
|---|---|
| `just build` | 两条都跑：先 `build-apps` 产包，再 `build-shell` 出安装包。要发东西就跑这条 |
| `just build-apps` | 只逐应用构建并打成 `dist-apps/<id>.airship` 归档 |
| `just build-shell` | 只打壳的安装包：清场 → 编译壳 → NSIS → 自检（`.sha256` 由自检写） |
| `just compile` | 只编译壳的三个目标 → `src/shell/out/`（`dev` 之外的两条都要它） |
| `just verify-installer` | 出包后自检：安装包在不在、是不是 NSIS 向导、体积、写 `.sha256`、六个包齐不齐 |
| `just icon` | 由母版 `assets/icon-master.png` 重出 `assets/icon.ico`（16/24/32/48/64/128/256） |
| `just shot` | 逐窗口截图，验证"真的跑起来了"（安装包出之前至少跑一遍） |

> 清场（`code/clean-installer.mjs`）为什么算必要步骤：安装包的名字只由 `package.json` 的 version
> 决定，不 bump 版本号就永远是同一个文件名；一次没写成安装包的运行（`dist` 半路失败，或只跑了解包）
> 会让上一次那颗原地留着冒充刚出的那版。`verify-installer` 按名字匹配、只验 PE 头与 NSIS 签名，
> 对旧包照样全绿，还会把 `.sha256` 一起改成旧包的。规矩：**release/ 里的安装包永远等于最后一次构建，
> 宁可没有，不可有旧的**。清掉的这颗重跑一次 `dist` 就回来；`win-unpacked` 不在删除范围内。

## 里面装了什么

1. `just build-apps` → `code/build-apps.mjs` 逐应用构建，打成 `dist-apps/<id>.airship`（zip 归档换了扩展名）。
   **这些归档不进安装包**——壳是纯的。壳的产物里也没有应用代码：`src/shell/out/renderer` 只有启动器那一份文档。
2. `electron-vite build` → `out/main` + `out/preload` + `out/renderer`（只有 `shell/launcher.html`）。
3. `electron-builder --win nsis`：
   - `app.asar` ← `out/**`、`package.json`、`assets/icon.png`、`assets/tray.png`；
   - `resources/` 里只有 `app.asar` 与 NSIS 的 `elevate.exe`：**没有任何 airship 包**（纯壳）。
   - `pdfjs-dist`、`foliate-js`、`@napi-rs/canvas` 被显式排除——渲染侧的东西 vite 已经打进各家的包里，
     node_modules 里那份只是构建期依赖，留着纯属占地方（排除后安装包 132 MB → 116 MB）。
4. NSIS 向导：`只为我安装`（不需要管理员权限）、可选安装目录、开始菜单 + 桌面快捷方式、
   控制面板里的卸载项；卸载**不动**用户数据（`%APPDATA%/airship` 里是书架与设置），
   也**不动**自装根 `%LOCALAPPDATA%\airship\apps`——重装壳立刻认出这些包。
   向导语言按系统界面语言自动选中简中或英文。

## 版本号

安装包文件名、exe 的文件版本、卸载项显示都取自 **`src/shell/package.json` 的 `version`**——
出包的项目根是壳那个包（`electron-builder --projectDir src/shell`），版本号就在这一处。
包清单里的 `sdkVersion` 另取 `src/sdk/package.json`：SDK 与壳将来分开发版，这两个数会分开走（TD-013）。
壳的 `package.json` 里 electron 写**固定版本**（`45.2.3`，不带 `^`）——electron-builder 要按它取二进制，写范围会被拒。

## 已验证到哪一步

- `just build` 出包 + `just verify-installer` 自检通过：MZ 头、NSIS 签名、SHA256、win-unpacked 主 exe，
  外加拆包后新加的两条——**安装包里各归档齐不齐**（读 zip 的中央目录，每个都要有 `manifest.json` + `index.html` + 一张图标），
  以及**壳的产物里不该再留着应用的 chunk**（`src/shell/out/renderer/assets` 只有壳自己的文件）。
- **纯壳装出来确实没有应用**：`release/win-unpacked/飞船.exe` 不带 `AIRSHIP_APPS_ROOT` 跑起来，
  日志喊「一个应用都没装进来」并把找过的包根列出来，界面上是 SH-020 那句，不是空白一屏。
  把一个归档放进 `%LOCALAPPDATA%\airship\apps` 再跑，日志变成 `origin:"installed"`、格子里出现它。
- **打包版真跑过**（开发根喂 `dist-apps/`）：`--shot` 七个窗口（启动器 + 六个应用）都开出来并截到图；
  再带 `AIRSHIP_AUTOTEST` 导入一份真 PDF，页面渲染正常。
  拆包后这条重跑过一次：窗口加载的是 `airship://<id>/index.html`，PDF 的 worker 从包里取、
  EPUB 的章节样式表（`blob:airship://books/…`）也画得出来——后者是拆包时撞出来的一处 CSP 回归，
  补了 `style-src blob:` 才对齐。
- **范本真造过一次应用**：`just new-app hello 你好` → 壳扫出七个包、启动器多一格、窗口开得出来，
  壳侧与 SDK 一个字没改；验完删掉（不变量 I-5 的第二次演练）。
- 打包版与开发版共用 `%APPDATA%/airship`，装上去书架是同一份。
  这个目录名靠主进程开头一句 `app.setName('airship')` 钉住——壳的包名是 `@airship/shell`，
  不钉的话 Electron 会把数据写进 `%APPDATA%/@airship/`，老用户的书架看着就像空了。

## 没做的事（实话）

集中在 [todo.md](todo.md)：TD-003 没有代码签名、TD-004 没有自动更新链路、TD-005 想要 Inno Setup 那一档观感要先装 Inno 6、
TD-013 SDK 独立发布与版本协商、TD-014 装包与商店链路。
**拆包不减安装包体积**：`app.asar` 从 3.4 MB 降到壳自己的约 0.7 MB，六个归档合计约 1.2 MB 换个地方放着
（zip 压过，比目录形态小一半上下），React 还复制了六份——换来的是"改一个应用只重出一个包"与"应用能独立分发"，不是体积。

对拿到安装包的人来说只有一条要预告：**没有签名，第一次运行会被 SmartScreen 拦一道"未知发布者"**，
点"仍要运行"就过去了。

## 客户机要求

- Windows 10 起（Electron 45 的下限），实际建议 Windows 11；
- 只有容器台还有额外要求：本机要有 `C:\Program Files\WSL\wslc.exe`（WSL 3 自带）。
  没有也能装能跑，容器台会读得到"这台机器上没有 wslc"，其余应用不受影响。
