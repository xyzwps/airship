# 打包分发（Windows 安装包）

飞船有**两个分发物**，互不包含：

1. **runtime 安装包**——一个 `airship-runtime-Setup-<版本>-x64.exe`，装一次、大家共用，
   钉死装进 `C:\Program Files\airship\runtime`（要管理员）。它是**纯 runtime**：一个应用都不带。
2. **应用安装器**——每个应用一个 `<id>-Setup-<版本>.exe`，每用户安装（不要管理员），
   把那份 `<id>.airship` 装进 `%LOCALAPPDATA%\airship\apps\<id>\`，留一枚快捷方式当启动程序。

**客户机不需要装 Node、不需要装 Electron。** runtime 安装包自带 Electron；应用安装器只裹一个归档，
跑起来靠已装好的 runtime。

```bash
just build                # 一条命令三样都出：runtime 安装包 → 各应用的包 → 各应用的安装器
just app-installer life   # 只重出那一个应用的安装器
just installers           # 只重出全部应用的安装器（先产全部的包）
```

产物：

| 路径 | 说明 |
|---|---|
| `release/airship-runtime-Setup-<版本>-x64.exe` | runtime 安装包（纯 runtime），**分发 runtime 只发这一个文件** |
| `release/airship-runtime-Setup-<版本>-x64.exe.sha256` | 同内容的 SHA256，防下载/传输被改动 |
| `release/win-unpacked/` | 免安装的散装目录（`airship.exe` 带一份包路径直接双击也能跑，给自己调试用） |
| `release/apps/<id>-Setup-<版本>.exe` | 各应用的每用户安装器（+ 同名 `.sha256`），**分发应用发这个** |
| `dist-apps/<id>.airship` | 各应用包（zip 归档换了扩展名），应用安装器的输入 |
| `release/*.blockmap` / `latest.yml` | 增量更新用的旁文件，现在用不上，留着不碍事 |

## 命令速查

| 命令 | 做什么 |
|---|---|
| `just build` | 三样都跑：`build-runtime` 出 runtime 安装包 → `build-apps` 产包 → `installers` 逐个裹安装器 |
| `just build-apps` | 只逐应用构建并打成 `dist-apps/<id>.airship` 归档 |
| `just build-runtime` | 只打 runtime 安装包：清场 → 编译 → NSIS → 自检（`.sha256` 由自检写） |
| `just app-installer <id>` | 产那一个应用的安装器：先产它那份包，再裹成每用户 `setup.exe` |
| `just installers` | 产全部应用的安装器：先 `build-apps`，再对名单里每个应用各裹一枚（名单与产包同源 `code/app-dirs.mjs`） |
| `just compile` | 只编译 runtime 的两个目标 → `src/runtime/out/{main,preload}`（没有 renderer） |
| `just verify-installer` | 出包后自检（六件事，见下） |
| `just icon` | 由母版 `assets/icon-master.png` 重出 `assets/icon.ico` |
| `just shot` | 逐窗口截图，验证"真的跑起来了"（安装包出之前至少跑一遍） |

> **顺序**：应用安装器用的 `makensis` 是 electron-builder 缓存里那份（不引新依赖），
> 所以**先跑一次 `just build-runtime`**（electron-builder 会下载 NSIS 到缓存），再产应用安装器。
> 缓存里没有 makensis 时生成器会响亮报错并指回这条。
> `just build` 里 `installers` 就排在 `build-runtime` 之后，一条命令自己把这条顺序满足了。

> 清场为什么算必要步骤：runtime 安装包的名字只由
> `src/runtime/package.json` 的 version 决定，不 bump 版本号就永远是同一个文件名；一次没写成安装包的运行
> （`dist` 半路失败，或只跑了解包）会让上一次那颗原地留着冒充刚出的那版。`verify-installer` 按名字匹配、
> 只验 PE 头与 NSIS 签名，对旧包照样全绿，还会把 `.sha256` 一起改成旧包的。规矩：**release/ 里的安装包
> 永远等于最后一次构建，宁可没有，不可有旧的**。清场有两档：`clean-release` 整目录 `rm -rf release`，由
> `just build-runtime` 开头走（runtime 那一族与 `release/apps/` 一起归零，所以单独打完 runtime 包之后要重跑
> `just installers` 才有应用安装器）；`clean-app-installers` 走 `code/clean-installer.mjs apps` 那一档，删
> `release/apps/*-Setup-*` 那一族（exe / .sha256），由 `just installers` 走——应用名单是会变的，删掉的那个应用
> 留下的旧安装器同样会冒充最后一次构建。`win-unpacked` 会被整目录一起删掉，它每次由 electron-builder 整体重写。
> 删不动（实例还活着或被索引占用）时 `rm -rf` 非零退出，出包在第一步就断。
> 单独跑 `just app-installer <id>` 不经过 `apps` 那一档：它只删自己那一枚同名旧包（生成器里那条，同一条规矩）。

## 里面装了什么

1. `just build-apps` → `code/build-apps.mjs` 逐应用构建，打成 `dist-apps/<id>.airship`。
   **这些归档不进 runtime 安装包**——runtime 是纯的。包清单里的 `sdkVersion` 取**根** `package.json` 的 version。
2. `just compile` → `electron-vite build` 出 `out/main` + `out/preload` **两个**目标。
   runtime 没有自己的文档：配置里没有 renderer 目标，产物里也不许有 `out/renderer`
   （先 `rm -rf src/runtime/out` 再编，旧时代留下的 renderer 不清就会一直躺着冒充产物）。
3. `electron-builder --win nsis`（配置在 `src/runtime/electron-builder.yml` + `build/installer.nsh`）：
   - `app.asar` ← `out/**`、`package.json`、`assets/icon.png`、`assets/tray.png`；
   - `resources/` 里只有 `app.asar` 与 NSIS 的 `elevate.exe`：**没有任何 airship 包**（纯 runtime）。
     根 package.json 已经没有 dependencies（foliate-js / pdfjs-dist 各自记在用它的应用名下，都是
     devDependencies，构建期打进各家的包），所以不再需要"排除某个 node_modules 目录"那几条。
   - `perMachine: true`（要管理员），落点钉死 `C:\Program Files\airship\runtime`——目录的唯一真源在
     `installer.nsh` 的 `customInit`（`StrCpy $INSTDIR "$PROGRAMFILES64\airship\runtime"`），
     `allowToChangeInstallationDirectory: false` 去掉换目录页。升级时读到的旧 InstallLocation 同样被覆盖。
   - 主 exe 叫 `airship.exe`（`productName: airship`），应用快捷方式的目标就是它。
   - runtime 自己没有界面：不留桌面/开始菜单快捷方式，只留控制面板卸载项（`airship runtime`）。
     卸载**不动**用户数据（`deleteAppDataOnUninstall: false`，`%APPDATA%/airship` 里是书架与设置）。
   - 欢迎页（`installer.nsh` 的 `customWelcomePage`）把固定安装目录念给人看——安装过程能查看装哪，
     但目录仍钉死、不给改（`allowToChangeInstallationDirectory: false`）。
   - 完成页不带「运行」勾选、点「完成」直接关窗（`runAfterFinish: false` → `HIDE_RUN_AFTER_FINISH`）：
     runtime 自己没有界面，装完不该弹一个"要不要运行 airship"的提示。
   - 向导语言按系统界面语言自动选中简中或英文。
4. `just app-installer <id>` → `code/make-app-installer.mjs` 把 `dist-apps/<id>.airship` 裹成每用户
   `setup.exe`（契约 PK-031~035）。NSIS `RequestExecutionLevel user`：
   - 界面走 MUI2 向导（欢迎 / 进度 / 完成 + 卸载三页，简中+英文，图标用包内那张 `.ico`）：
     欢迎页念安装目录，进度页不刷日志，完成页点「完成」直接关窗。
   - `.onInit` 先念能力清单（措辞从 `@airship/contract` 烘进脚本，单一真源），取消就中止、一个文件都不写；
     再找 runtime（`AIRSHIP_PATH` > `C:\Program Files\airship\runtime`），找不到念一句"没找到 airship runtime"中止。
   - 落点 `$LOCALAPPDATA\airship\apps\<id>`，放进归档与包内那张图转成的 `icon.ico`。
   - 桌面 + 开始菜单各一枚快捷方式：目标 `"<runtime>\airship.exe"`，参数 `"<安装目录>\<id>.airship"`，
     两段都带引号，图标用应用自己那张 `.ico`（不是 runtime 的）。
   - HKCU 卸载项。卸载删安装目录、两处快捷方式、注册表，**不碰** `%APPDATA%` 里的设置与数据。
   - 这个 `.mjs` 直接 import `@airship/contract`（Node 24 的类型剥离吃得下契约包），措辞与 id 形状只有一份。

## 版本号

- **runtime 安装包**文件名、exe 文件版本、卸载项显示都取自 `src/runtime/package.json` 的 `version`
  （出包项目根是 `src/runtime`，`electron-builder --projectDir src/runtime`）。
- **包清单的 `sdkVersion`** 取**根** `package.json` 的 `version`（`code/build-apps.mjs`）。
  根与 `src/runtime/package.json` 这两个数**保持一致**——它们是同一个发布物，不一致等于清单在说谎。
- **应用安装器**文件名取 `src/apps/<id>/package.json` 的 `version`：各应用版本**独立演化**，不跟 runtime 跳。
- runtime 的 `package.json` 里 electron 写**固定版本**（`45.2.3`，不带 `^`）——electron-builder 要按它取二进制，写范围会被拒。

## 出包自检（六件事）

`code/verify-installer.mjs`（`build-runtime` 以它收尾）：

1. `release/` 里有对应 `src/runtime/package.json` 版本号的安装包；
2. 它像不像一个 Windows 安装程序（PE 的 MZ 头 + NSIS 的 NullsoftInst 签名）；
3. 旁边那份 `.sha256` 写好了没；
4. 免安装的 `win-unpacked` 里主 exe（`airship.exe`）在不在；
5. **安装包是不是纯 runtime**——`resources/` 里只有 `app.asar` 与 `elevate.exe`，不该有任何 airship 包；
6. **runtime 产物里没有渲染目标与启动器通道**——`out/renderer` 不该存在，`out/main` 与 `out/preload`
   里不该出现 `launcher:` 或 `airshipShell`（启动器那一族退场之后，它们留在产物里就是有人把旧面合回去了）。

## 已验证到哪一步

- **八窗口真跑过**（本轮 `just shot`，编译产物直跑）：argv 一次指来全部八份包，截图工装逐个开窗口、
  按下快门、关掉再下一个，八张图都截到（`shots/<id>.png`），窗口加载的是 `airship://<id>/index.html`。
  每窗口工作集与首屏耗时见 `docs/architecture.md` §3.1。
- **runtime 安装包出包 + 自检通过**：`just build-runtime` 产 `airship-runtime-Setup-0.4.0-x64.exe`，
  六件自检全绿（MZ 头、NSIS 签名、SHA256、win-unpacked 主 exe、纯 runtime、产物无 renderer/启动器通道）。
- **本轮四处安装 UX 改动**（2026-11-19）：runtime 欢迎页念固定安装目录（`installer.nsh` 的 `customWelcomePage`）、
  完成页点「完成」直接关窗（`runAfterFinish: false`）；应用安装器套 MUI2 向导；首次直跑的能力确认卡片删除
  （授权只在安装期，PK-033）。验证到：`just check` 全绿（558 过 / 10 跳过，casecov 零差集）、runtime 安装包重出六检全绿、
  八个应用安装器带 MUI2 真编译产出。**真机安装走查**（欢迎页真念出路径、完成真不弹窗、双击应用真不再弹卡片）
  要装一遍才算数——把 runtime 装进 Program Files 是系统级动作，由使用者执行。
- **应用安装器真装真卸过**（第三档样件，life）：双击快捷方式跑得起（日志 `[life] 应用窗口已打开`）；
  卸载把安装目录、两处快捷方式、HKCU 注册表删净，`%APPDATA%` 里的数据 SHA256 前后相同。
- 打包版与开发版共用 `%APPDATA%/airship`，装上去书架是同一份。这个目录名靠主进程开头一句
  `app.setName('airship')` 钉住——runtime 的包名是 `@airship/runtime`，不钉的话 Electron 会把数据写进
  `%APPDATA%/@airship/`，老用户的书架看着就像空了。

## 没做的事（实话）

集中在 [todo.md](todo.md)：TD-003 没有代码签名、TD-004 没有自动更新链路、TD-005 想要 Inno Setup 那一档观感
要先装 Inno 6、TD-013 SDK 独立发布与版本协商、TD-014 装包的来源信任与更新链路。

对拿到安装包的人来说只有一条要预告：**没有签名，第一次运行会被 SmartScreen 拦一道"未知发布者"**，
点"仍要运行"就过去了。runtime 安装包要管理员（装进 Program Files）；应用安装器不要（每用户）。

## 客户机要求

- Windows 10 起（Electron 45 的下限），实际建议 Windows 11；
- 先装 runtime，再装应用（应用安装器找不到 runtime 会中止）；
- 只有 wsld 还有额外要求：本机要有 `C:\Program Files\WSL\wslc.exe`（WSL 3 自带），
  或用 `AIRSHIP_WSLC_PATH` 显式指一个。没有也能装能跑，wsld 会读得到"这台机器上没有 wslc"，其余应用不受影响。