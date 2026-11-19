# airship · 给代理的说明

飞船是一个 **airship runtime**（一个 Electron 运行时，像 JVM / .NET 那样装一次大家共用），
外面挂着八个自用应用（墨读 · PDF · 打勾勾 · 生命游戏 · vcp · 容器台 · Albedo · S3）。
一个应用一个窗口一个渲染进程，**一个应用是一个 airship 包（zip 归档 `<id>.airship`），由命令行指给 runtime 注册**——
runtime 的产物里没有应用代码，runtime 自己也没有界面。多个应用共用一个 runtime 进程，第二次启动转发包路径。
这里只写"不照做就会做错"的事；架构理由见
[docs/architecture.md](docs/architecture.md)，用户可见契约见 [docs/specs/index.md](docs/specs/index.md)。

## 动手之前

1. **命令只走 justfile**。`package.json` 里没有 `scripts`，别再往回加；`just` 不带参数就列出全部配方。
2. **待办只看 [docs/todo.md](docs/todo.md)**，别处不留零碎待办。**没人做过决定时，不要擅自记录任何 todo。**
3. **改之前先读对应的规格册**（`src/<区>/<名>/specs/*.md`）。册子是契约，用例是它的影子，不是反过来。
4. 工作树里可能有**使用者自己正在改的东西**。不是你这轮改的文件别动；发现冲突先说清"发布物是否已包含它"再让他挑。

## 命令

```
just build-apps        产各应用的 airship 包到 dist-apps/
just dev id            直跑那一个应用（先 build-apps；文档热更，清单与图标走包）
just start id          跑构建好的产物（文档从包里加载，与装好的 runtime 最接近）
just new-app id 名     从 templates/app 造一个新应用（复制、换名、链 workspace、只产它的包）
just compile           编译 runtime 的两个目标（src/runtime/out/{main,preload}，没有 renderer）
just shot              逐窗口截图（先 compile + build-apps），打每窗口内存与首屏耗时
just app-installer id  产那一个应用的每用户安装器（release/apps/<id>-Setup-<版本>.exe）
just installers        产全部应用的安装器（先 build-apps；名单与产包同源 code/app-dirs.mjs）
just test              单测            just casecov        册子编号与用例编号的双向差集
just typecheck         两个 tsconfig   just check          提交前一轮（类型 + 单测 + 差集）
just icon              由母版重出 runtime 的 icon.ico
just build-runtime     打 runtime 安装包（清场 → 编译 → NSIS → 自检）
just build             三样一起跑（runtime 安装包 → 各应用的包 → 各应用的安装器）   just verify-installer  出包自检
just e2e / just wsld-real           要真环境的那两档（ffmpeg / wslc）
```

`just dev` 与 `just shot` 都吃 `dist-apps/`：改了 `app.ts`（清单）要重跑 `just build-apps` 才生效，
只改组件源码不用——应用的**文档**在 dev 下走 vite dev server，**清单与图标**走包。
`just shot` 一次把全部包指给 runtime（`--shot dist-apps/*.airship`），逐个开窗截图。

## 每个区都是一个包，方向不许反

```
src/runtime            @airship/runtime      主进程、preload、窗口、能力实现、包协议、单实例转发；不认识任何具体应用
src/sdk                @airship/sdk          宿主（标题栏 / 主题落地 / 留白 / 占位）、图标键、CSP、工装钩子
                                             子入口：./testing（假 runtime 与挂载器）、./styles.css、./vite（CSP 注入插件）
src/apps/<id>          @airship/<id>         八个应用，各自自持 index.html + main.tsx
src/shared/contract    @airship/contract     契约、清单类型、拒绝措辞、注册与包形状的规矩
src/shared/library     @airship/library      共享书库（墨读与 PDF 同一份数据）
src/shared/textdecode  @airship/textdecode   中文解码
```

根 `package.json` 只声明 `workspaces`，**没有 scripts**；每个包的 `package.json` 里 SDK 与 react 记在
`devDependencies`——它们被构建进包，运行时不需要机器上装着（AP-016 钉这条）。
说明符一律写包名（`@airship/...`），**手写别名已全部拆掉**：边界现在由 node 的解析器守，不靠注释。

**版本号只有两条规矩**：根 `package.json` 与 `src/runtime/package.json` **保持一致**——它们是同一个发布物，
就该念同一个数（`code/build-apps.mjs` 取根那份当包清单里的 `sdkVersion`，两处不一致等于清单在说谎）；
各应用自己的 `package.json` 版本**独立演化**，不跟 runtime 跳，一个应用发自己的版不该惊动别的区和 runtime。

应用与 SDK 都不许 import `src/runtime/**`（AP-013 守着）；runtime 也不 import 任何应用——
名单来自命令行指来的包，不是写死的 id 表。`src/sdk` 是将来要独立发布的那一份，改它的导出等于改公开面（TD-013）。
runtime 给应用窗口的 DOM 只有 SDK 那一份——`src/runtime` 里没有 `AppHost`，也没有 `app.html`，更没有启动器。

## 加一个应用 = 造一个包

别手抄，用范本：`just new-app hello 你好` → `src/apps/hello/`，改三处（`app.ts`、`hello.css`、
`specs/hello.md`），`just build-apps` 产包，`just app-installer hello` 产安装器，`just shot` 看窗口。
**runtime 侧任何文件都不用改**。

一个应用该有的文件：`package.json`、`app.ts`（纯数据清单）、`index.html`（入口文档，
引 `./main.tsx`，**里面不写 CSP**）、`main.tsx`（一行 `createAirshipApp({ meta, component, icon })`）、
`icon.svg|png|jpg|jpeg|webp`（**有且只有一张**，不套底板，颜色烘进图里）；缺哪件产包期炸哪件。
**runtime 侧任何文件都不用改**——runtime 运行期注册命令行指来的包（`airship.exe <id>.airship`），
不扫磁盘、没有"包根"那回事。这条有用例守着（AP-010：runtime 产品代码里不许出现具体应用 id 的字面量）。

清单只写"这个应用自己的事实"：`id / name / description / capabilities / platforms / tools /
sharedNamespaces / flush / defaultWidth / defaultHeight`。**不写** `iconPath`、`order` 这类表现或关系字段
（都被驳回过）——图标是文件约定，排序不存在（没有启动器格子要排）。
`capabilities` 是唯一授权面，没声明的一律拒绝；用不到就写 `[]`（生命游戏就是这么起的）。
用了 `api.settings.` / `api.proc.` 这些域就必须声明对应能力，AP-011 会扫。

包格式（**归档文件名** `<id>.airship`——里面是一个 zip，条目名就是包内路径；`manifest.json` 的字段、id 的形状、引用不许越出包）
的唯一叙述是 `src/apps/specs/package.md`；产包器 `code/pack-app.mjs` 与 runtime 侧 `@airship/contract`
各判一遍，两份由用例比对输出相等来钉——原因不是偷懒：**Node 自己解不开本仓 TS 里那种不带扩展名的
相对 import**，所以 `.mjs` 引不了 `.ts`。也因此，被 Node 直接加载的那几个源码包（`@airship/sdk`、
`@airship/contract` 等）内部的相对 import **必须写扩展名**（`./csp.ts`），新加文件时别忘了。
（`code/make-app-installer.mjs` 是例外：Node 24 的类型剥离吃得下契约包，它直接 import `@airship/contract`，措辞只一份。）

## 规格册

四档结构（Purpose → Requirement → Scenario → WHEN/THEN），每条 Scenario 带稳定编号（`BK-032` 这种），
**只写可观察结果**：界面读得到哪句话、错误文案原文、交给外部 CLI 的命令行、落盘文件的形状。
不写实现——不出现类名、方法名、控件名。一条 Scenario ≤ 5 行，只锁一个不变量。

- 编号是稳定句柄：不复用、不重排；删除是显式动作，要说清这条契约为什么不再成立。
- 用例标题以编号开头，`just casecov` 做双向差集：册里有号没用例 = 未实现，用例挂了号册里没有 = 私测（禁止）。
- **界面观感（宽度、圆角、对齐、真排版好不好看）不进册子**，那是 `just shot` 截图走查的事，截图产物不入代码库。
- 写不出可执行判据的期望别进册子，记到 architecture.md 对应小节。

## 墨读支持的格式

**只有 EPUB 与 MOBI。** 唯一真源是 `src/shared/library/index.ts` 的 `BookFormat`
（`'epub' | 'mobi' | 'pdf'`，pdf 是 PDF 应用那侧的位）。TXT 与 azw3 都在 2026-11-06 被退回，
别把文件选择框里的扩展名别名当契约——要加格式是一次契约变更：改类型 + 开册子场景 + 造样本。

## 出包

两个分发物，互不包含：

- `just build-runtime` = 清场 → 编译 runtime → NSIS → 自检 + 写 `.sha256`。安装包是**纯 runtime**，
  `perMachine: true`（要管理员），落点钉死 `C:\Program Files\airship\runtime`（目录唯一真源在
  `src/runtime/build/installer.nsh` 的 `customInit`）。项目根是 `src/runtime`（`--projectDir`），
  所以**安装包文件名只由 `src/runtime/package.json` 的 `version` 决定**（`airship-runtime-Setup-<版本>-x64.exe`，
  主 exe 叫 `airship.exe`）。runtime 自己没有界面，不留快捷方式，只留控制面板卸载项。
- `just app-installer id` = 先产它那份包，再裹成**每用户**安装器（`RequestExecutionLevel user`，不要管理员），
  落 `%LOCALAPPDATA%\airship\apps\<id>\`，桌面 + 开始菜单各一枚快捷方式（目标 runtime 的 `airship.exe` + 引号包路径 + 应用 `icon.ico`）。
  版本读 `src/apps/<id>/package.json`。
- `just installers` = 先 `build-apps`，再对**全部**应用各产一枚安装器（不给 id 就是全部，名单与产包同源
  `code/app-dirs.mjs`）。应用安装器用的 makensis 是 electron-builder 缓存里那份，所以**这台机器上第一次要先跑过
  `just build-runtime`**——`just build` 把它排在 build-runtime 之后，一条命令里就顺了。

出包入口必须先删旧包：**宁可响亮报错没有，不许旧包冒充新包**（`code/clean-installer.mjs` 两档：默认删
`airship-runtime-Setup-*` 那一族，`apps` 那一档删 `release/apps/*-Setup-*` 那一族，由 `just installers` 走）。
没有代码签名，第一次运行会被 SmartScreen 拦一道。

**装包只有一条路：跑应用自己的安装器**（契约 PK-031~035）。从前"把归档拖到启动器上"那一族随启动器退场了
（PK-015~019、PK-021~026 已显式删除，见 package.md 末尾注记）。安装器 `.onInit` 先找 runtime
（`AIRSHIP_PATH` > `C:\Program Files\airship\runtime`，找不到念 `runtimeNotFound` 中止），再念能力清单确认。
能力措辞由 `@airship/contract` 供（`CAPABILITY_LABEL` / `capabilitiesPhrase` / `installConfirmMessage`），
**别在界面或 NSI 里另写一份**——安装器安装页念的就是契约层这一份。
路径只能由 preload 的 `webUtils.getPathForFile(file)` 换出来——渲染侧拿不到绝对路径，也拿不到 ipcRenderer。

`just build-apps` 的产物只落在 `dist-apps/`，**不进 runtime 安装包**：runtime 是纯的，`resources/` 里只有 `app.asar`。
`just verify-installer` 因此钉的是反面：`resources/` 里**不该**有任何 airship 包，runtime 产物里也不该有
`out/renderer` 或启动器通道（`launcher:` / `airshipShell`）。

**授权在安装期一次完成**（PK-033）：应用安装器装前念能力清单，装完双击快捷方式直接开窗口。
从前"首次直跑陌生包弹能力确认卡片"那一族（`runConfirm`，PK-027~030）已于 2026-11-19 退场——
双击应用先弹一张卡片太烦，而装的时候已经念过清单、点过确定。`run-confirm.json` 与契约层
`runConfirmMessage` / `runConfirmDetail` / `runDeclined` 一并删除，直跑不再有任何确认闸门。

## 写用例的规矩

替身（`@airship/sdk/testing` 的 `FakeAirship` 与 `mountUi`）**只能实现真 API 面上存在的方法**。
它住在 SDK 而不是 runtime 的测试目录：应用不许引 runtime，用例也不能——否则"包自持"在测试里是假的，
而且外部作者复制范本出去后拿不到同一个替身。
教训有两条：替身窗口写过 `setAppUserModelId`（BrowserWindow 上根本没有这个方法），用例绿着而真机没生效（TD-001）；
`window.x?.()` 这种可选链会把"方法不存在"吞成静默空操作——缺什么要喊出来，别默默跳过。
jsdom 没有 2D canvas：画布类判据只断言文字、状态与几何数字，"真画出来了"归 `just shot`。
整面 `vi.mock('@airship/sdk', ...)` 会把 SDK 的其他导出一起抹掉（踩过：`useTheme` 凭空不见），
要部分替换就用 `vi.mock('@airship/sdk', async (importOriginal) => ({ ...(await importOriginal()), ... }))`。

## 汇报口径

性能按**用户可感知的指标**报，并且要有实测数字（`just shot` 会打每窗口内存与首屏耗时）；
没解决就说没解决，别用"符合设计"辩护。外部引用（法条、标准、格式规范、他人库的行为）先查原文再断言——
连"凭记忆的形状与常数"也一样，先穷举 + 实测再写进数据里。

## 本机事实

- Shell 是 Git Bash + PowerShell 5.1，控制台默认 **GBK**：Python 脚本里打印 `✓` 或韩文会 `UnicodeEncodeError`，
  用 ASCII 或中文（GBK 能编码）；乱码输出不代表文件坏了。PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` 按 GBK 解，
  所以 `.ps1` 要纯 ASCII；bash 双引号里 `$_` 会被展开，要写 PowerShell 就落成 `.ps1` 再 `-File`。
  Git Bash 的 MSYS 路径转换会破坏 NSIS 的 `/S`，静默安装走 `cmd //c "set VAR=...&& prog.exe /S"`。
- Electron 与 electron-builder 的二进制走 npmmirror：`.npmrc` 里配了 `electron_mirror` 与
  `electron_builder_binaries_mirror`，`just build-runtime` 里也显式带上同名环境变量。
- Pillow 不认 SVG，无头 Chrome 截内联 SVG 会出空白；要 SVG→位图用 `@resvg/resvg-js`（根 devDep）。
  应用安装器把包内 SVG 图标经 resvg 出 256 PNG，再交 `code/app-ico.py`（Pillow）转多尺寸 `.ico`。
- 系统级动作（重启 explorer、清图标缓存、覆盖安装、**把 runtime 装进 Program Files**）**只给命令，由使用者执行**，别自己跑。
- 工具脚本一律放 `code/`（现成有 `make-ico.py`、`make-icons.py`、`app-ico.py`、`make-jingang-epub.py`、`make-mobi.py`、
  `make-rustfs-demo.mjs`、`clean-installer.mjs`、`verify-installer.mjs`、`pack-app.mjs`、`build-apps.mjs`、
  `make-app-installer.mjs`、`app-dirs.mjs`（应用名单的唯一判据，产包与产安装器共用）、`new-app.mjs`、`app.vite.config.mts`）；中间产物写到系统临时目录，别落在仓库里。
  `src/runtime/out/`、`dist-apps/`、`release/`、`shots/` 都不入库，根目录保持干净。
- `mkdtempSync` 在 `node:fs` 不在 `node:os`（踩过：从 os 引拿到 undefined，症状是包工装静默失效）。
  用例的包目录每次 `mkdtempSync` 新开一个，不按 pid 复用——Windows 上 `rmSync(force)` 会把"删不掉"咽下去，
  旧格式的残包留在原地，注册就"安静地空着"，报出来只是"未知的应用 id"，看不出工装坏了。
- **npm workspaces 的软链按调用进程的 cwd 拼法落盘**：用 `develop` 起进程、再用 `Develop` 跑 tsc，
  同一份文件会以两种大小写进程序，报一串看不懂的 `TS1261 / differs only in casing`。
  这台机器上真实目录是 `C:\Users\xyzwp\Develop\airship`，**命令一律按这个拼法走**；
  已经踩了就 `rm -rf node_modules/@airship && npm install` 重建软链，再顺手清 `node_modules/.vite`。
  npm install/prune 不清 lock 里已不存在的 workspace 孤儿条目（踩过 `src/shell`），要手删那一块。
- 源码包（`@airship/*`）被 Node 直接加载时解不开省略扩展名的相对 import，症状是
  `import * as x from '@airship/sdk/testing'` 拿到一个**空对象**而不是报错——比抛错难查得多。
  所以这些包内部写 `./foo.ts` / `./foo.tsx`；vitest 那边还要 `server.deps.inline: [/^@airship\//]`。
- `app.setName('airship')` 是必须的：Electron 的 userData 默认取 package.json 的 name，
  而 runtime 的 name 现在是 `@airship/runtime`——不钉住的话 `%APPDATA%/airship` 里的书架与设置会"凭空消失"。
- runtime 的 `package.json` 里 electron 必须写**固定版本**（`45.2.3`，不带 `^`）：
  electron-builder 要按它下载对应平台的二进制，写范围会直接报 `is a range, not a fixed version`。
- workspace 软链进 `node_modules` 后，rollup 的 commonjs 互操作会把 `react` 各包一遍，
  现象是 `useState` 读到 `null`。三份构建配置（`src/runtime/electron.vite.config.ts`、
  `src/runtime/electron.vite.dev.config.ts`、`code/app.vite.config.mts`）都写了
  `resolve.dedupe: ['react','react-dom','react/jsx-runtime']`，摘掉就崩——别按"看起来多余"删它。
- 归档读取用 fflate（`@airship/runtime` 的依赖）：`unzipSync(data, { filter })` 只解需要的那个条目，
  列条目名时 filter 一律返回 false，不解压内容。别改成整包 `unzipSync`——八个包全展开是白给的内存。
- 自定义方案 `airship://<id>` 下，`blob:` 的 URL 不再被 `'self'` 覆盖：foliate 注入的章节样式表是
  `blob:airship://books/…`，`style-src` 不写 `blob:` 就被拦掉（2026-11-07 截图走查抓到过一次）。
- 用例的包工装在 `src/runtime/tests/helpers/packages.ts`（`writeFixturePackages` 把仓库真清单落成临时包目录）
  与 `src/runtime/tests/setup.ts`（每个用例文件开局逐个 `registerPackageAt` 铺活动包表）。
  runtime 现在运行期注册命令行指来的包，没有这一步所有问注册表的用例全空——**空表不算通过**，`AP-008` 钉着这条。
- 单实例锁要在 `whenReady` 之前抢，抢不到时 `whenReady` 里一步都不走（不然第二实例开出一扇重复窗再退出）。
  截图模式（`AIRSHIP_SHOT=1 --shot`）用独立 userData、不参与单实例，且 `window-all-closed` 要直接 return——
  它逐个开窗关窗，跟着 quit 就只截得到第一个（启动器退场后抓到的一次回归）。
- `templates/app/` 是给别人复制的范本，**不参与** `just casecov` 的双向差集，也不被 vitest 跑
  （两处都按目录名 `templates` 排除）；复制进 `src/apps/<id>/` 之后才归这套规矩管。

## 沟通

全中文。只答被问的那件事，别顺带交付额外的文书、全景或多方案矩阵；延伸只留一句提问。
**提交由使用者发起**——改完停在"未提交"，除非他明说提交。