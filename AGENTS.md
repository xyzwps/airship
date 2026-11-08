# airship · 给代理的说明

飞船是一个 Electron 壳，里面装着六个自用应用（墨读 · 打勾勾 · 生命游戏 · PDF · vcp · 容器台）。
一个应用一个窗口一个渲染进程，**一个应用是一个 airship 包（zip 归档 `<id>.airship`），运行期被壳扫出来**——壳的产物里没有应用代码。
这里只写"不照做就会做错"的事；架构理由见
[docs/architecture.md](docs/architecture.md)，用户可见契约见 [docs/specs/index.md](docs/specs/index.md)。

## 动手之前

1. **命令只走 justfile**。`package.json` 里没有 `scripts`，别再往回加；`just` 不带参数就列出全部配方。
2. **待办只看 [docs/todo.md](docs/todo.md)**，别处不留零碎待办。**没人做过决定时，不要擅自记录任何 todo。**
3. **改之前先读对应的规格册**（`src/<区>/<名>/specs/*.md`）。册子是契约，用例是它的影子，不是反过来。
4. 工作树里可能有**使用者自己正在改的东西**。不是你这轮改的文件别动；发现冲突先说清"发布物是否已包含它"再让他挑。

## 命令

```
just build-apps     产各应用的 airship 包到 dist-apps/   just dev    开发（先 build-apps）
just new-app id 名  从 templates/app 造一个新应用（复制、换名、链 workspace、只产它的包）
just compile        编译壳的三个目标（src/shell/out/）   just shot   逐窗口截图（先 compile + build-apps）
just test           单测            just casecov        册子编号与用例编号的双向差集
just typecheck      两个 tsconfig   just check          提交前一轮（类型 + 单测 + 差集）
just icon           由母版重出壳的 icon.ico
just build-shell    打壳的安装包    just build  两条一起跑    just verify-installer  出包自检
just e2e / just wsld-real           要真环境的那两档（ffmpeg / wslc）
```

`just dev` 与 `just shot` 都吃 `dist-apps/`：改了 `app.ts`（清单）要重跑 `just build-apps` 才生效，
只改组件源码不用——应用的**文档**在 dev 下走 vite dev server，**清单与图标**走包。

## 每个区都是一个包，方向不许反

```
src/shell              @airship/shell        主进程、preload、启动器；不认识任何具体应用
src/sdk                @airship/sdk          宿主（标题栏 / 主题落地 / 留白 / 占位）、图标键、CSP、工装钩子
                                            子入口：./testing（假壳与挂载器）、./styles.css、./vite（CSP 注入插件）
src/apps/<id>          @airship/<id>         六个应用，各自自持 index.html + main.tsx
src/shared/contract    @airship/contract     契约、清单类型、拒绝措辞、注册与包形状的规矩
src/shared/library     @airship/library      共享书库（墨读与 PDF 同一份数据）
src/shared/textdecode  @airship/textdecode   中文解码
```

根 `package.json` 只声明 `workspaces`，**没有 scripts**；每个包的 `package.json` 里 SDK 与 react 记在
`devDependencies`——它们被构建进包，运行时不需要机器上装着（AP-016 钉这条）。
说明符一律写包名（`@airship/...`），**手写别名已全部拆掉**：边界现在由 node 的解析器守，不靠注释。

**版本号只有两条规矩**：根 `package.json` 与 `src/shell/package.json` **保持一致**——它们是同一个发布物，
就该念同一个数（`code/build-apps.mjs` 取根那份当包清单里的 `sdkVersion`，两处不一致等于清单在说谎）；
各应用自己的 `package.json` 版本**独立演化**，不跟壳跳，一个应用发自己的版不该惊动别的区和壳。

应用与 SDK 都不许 import `src/shell/**`（AP-013 守着）；壳也不 import 任何应用——名单来自运行期扫包。
`src/sdk` 是将来要独立发布的那一份，改它的导出等于改公开面（TD-013）。
壳给应用窗口的 DOM 只有 SDK 那一份——`src/shell` 里不再有 `AppHost`，也没有 `app.html`。

## 加一个应用 = 造一个包

别手抄，用范本：`just new-app hello 你好` → `src/apps/hello/`，改三处（`app.ts`、`hello.css`、
`specs/hello.md`），`just build-apps` 产包，`just shot` 看窗口。壳侧任何文件都不用改。

一个应用该有的文件：`package.json`、`app.ts`（纯数据清单）、`index.html`（入口文档，
引 `./main.tsx`，**里面不写 CSP**）、`main.tsx`（一行 `createAirshipApp({ meta, component, icon })`）、
`icon.svg|png|jpg|jpeg|webp`（**有且只有一张**，不套底板，颜色烘进图里）；缺哪件产包期炸哪件。
**壳侧任何文件都不用改**——壳运行期扫包根（`services/packageRoots.ts` 的两个根：开发根与自装根）。
这条有用例守着（AP-010：壳里不许出现具体应用 id 的字面量）。

清单只写"这个应用自己的事实"：`id / name / description / capabilities / platforms / tools / flush /
defaultWidth / defaultHeight`。**不写** `iconPath`、`order` 这类表现或关系字段（都被驳回过）。
`capabilities` 是唯一授权面，没声明的一律拒绝；用不到就写 `[]`（生命游戏就是这么起的）。
用了 `api.settings.` / `api.proc.` 这些域就必须声明对应能力，AP-011 会扫。

包格式（**归档文件名** `<id>.airship`——里面是一个 zip，条目名就是包内路径；`manifest.json` 的三个新字段、id 的形状、引用不许越出包）
的唯一叙述是 `src/apps/specs/package.md`；产包器 `code/pack-app.mjs` 与壳侧 `@airship/contract`
各判一遍，两份由用例比对输出相等来钉——原因不是偷懒：**Node 自己解不开本仓 TS 里那种不带扩展名的
相对 import**，所以 `.mjs` 引不了 `.ts`。也因此，被 Node 直接加载的那几个源码包（`@airship/sdk`、
`@airship/contract` 等）内部的相对 import **必须写扩展名**（`./csp.ts`），新加文件时别忘了。

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

`just build-apps` 产各应用的包；`just build-shell` = 清场 → 编译壳 → NSIS → 自检 + 写 `.sha256`；
`just build` 两条一起跑，但产物互不包含：安装包是纯壳，`dist-apps/` 里的归档等人来拖。
**没有单独的"只解包"配方**。项目根是 `src/shell`（`--projectDir`），所以**安装包文件名只由
`src/shell/package.json` 的 `version` 决定**；
出包入口必须先删旧包：**宁可响亮报错没有，不许旧包冒充新包**（`code/clean-installer.mjs`）。
没有代码签名，第一次运行会被 SmartScreen 拦一道。

装包只有一条路：**把 `<id>.airship` 拖到启动器上**（契约见 PK-015~019）。落点只有自装根
`%LOCALAPPDATA%\airship\apps`——安装包是纯壳，安装目录里没有应用；同 id 已经在自装根里必须先确认才覆盖；
装完只刷新格子、**不自动开窗口**。文件夹与别的扩展名一律拒，不做"帮你猜一下"的回落。
装包那行要念出的能力清单由 `@airship/contract` 的 `CAPABILITY_LABEL` 供措辞，别在界面里另写一份。
路径只能由 preload 的 `webUtils.getPathForFile(file)` 换出来——渲染侧拿不到绝对路径，也拿不到 ipcRenderer。

`just build-apps` 的产物只落在 `dist-apps/`，**不进安装包**：壳是纯的，`resources/` 里只有 `app.asar`。
`just verify-installer` 因此钉的是反面：`resources/` 里**不该**有任何 airship 包，壳的产物里也不该有应用 chunk。

## 写用例的规矩

替身（`@airship/sdk/testing` 的 `FakeAirship` 与 `mountUi`）**只能实现真 API 面上存在的方法**。
它住在 SDK 而不是壳的测试目录：应用不许引壳，用例也不能——否则"包自持"在测试里是假的，
而且外部作者复制范本出去后拿不到同一个替身。
教训有两条：替身窗口写过 `setAppUserModelId`（BrowserWindow 上根本没有这个方法），用例绿着而真机没生效；
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
  用 ASCII 或中文（GBK 能编码）；乱码输出不代表文件坏了。
- Electron 与 electron-builder 的二进制走 npmmirror：`.npmrc` 里配了 `electron_mirror` 与
  `electron_builder_binaries_mirror`，`just build-shell` 里也显式带上同名环境变量。
- Pillow 不认 SVG，无头 Chrome 截内联 SVG 会出空白；要 SVG→位图用 `@resvg/resvg-js`（需要时重装即可）。
- 系统级动作（重启 explorer、清图标缓存、覆盖安装）**只给命令，由使用者执行**，别自己跑。
- 工具脚本一律放 `code/`（现成有 `make-ico.py`、`make-icons.py`、`make-jingang-epub.py`、`make-mobi.py`、
  `clean-installer.mjs`、`verify-installer.mjs`、`pack-app.mjs`、`build-apps.mjs`、`new-app.mjs`、`app.vite.config.mts`）；
  中间产物写到系统临时目录，别落在仓库里。
  `src/shell/out/`、`dist-apps/`、`release/`、`shots/` 都不入库，根目录保持干净。
- `mkdtempSync` 在 `node:fs` 不在 `node:os`（踩过：从 os 引拿到 undefined，症状是包根工装静默失效）。
  用例的包根每次 `mkdtempSync` 新开一个目录，不按 pid 复用——Windows 上 `rmSync(force)` 会把"删不掉"咽下去，
  旧格式的残包留在原地，扫描就"安静地空着"，报出来只是"未知的应用 id"，看不出工装坏了。
- **npm workspaces 的软链按调用进程的 cwd 拼法落盘**：用 `develop` 起进程、再用 `Develop` 跑 tsc，
  同一份文件会以两种大小写进程序，报一串看不懂的 `TS1261 / differs only in casing`。
  这台机器上真实目录是 `C:\Users\xyzwp\Develop\airship`，**命令一律按这个拼法走**；
  已经踩了就 `rm -rf node_modules/@airship && npm install` 重建软链，再顺手清 `node_modules/.vite`。
- 源码包（`@airship/*`）被 Node 直接加载时解不开省略扩展名的相对 import，症状是
  `import * as x from '@airship/sdk/testing'` 拿到一个**空对象**而不是报错——比抛错难查得多。
  所以这些包内部写 `./foo.ts` / `./foo.tsx`；vitest 那边还要 `server.deps.inline: [/^@airship\//]`。
- `app.setName('airship')` 是必须的：Electron 的 userData 默认取 package.json 的 name，
  而壳的 name 现在是 `@airship/shell`——不钉住的话 `%APPDATA%/airship` 里的书架与设置会"凭空消失"。
- 壳的 `package.json` 里 electron 必须写**固定版本**（`45.2.3`，不带 `^`）：
  electron-builder 要按它下载对应平台的二进制，写范围会直接报 `is a range, not a fixed version`。
- workspace 软链进 `node_modules` 后，rollup 的 commonjs 互操作会把 `react` 各包一遍，
  现象是 `useState` 读到 `null`。三份构建配置（`src/shell/electron.vite.config.ts`、
  `code/app.vite.config.mts`）与 vitest 都写了 `resolve.dedupe: ['react','react-dom','react/jsx-runtime']`，
  摘掉就崩——别按"看起来多余"删它。
- 归档读取用 fflate（`@airship/shell` 的依赖）：`unzipSync(data, { filter })` 只解需要的那个条目，
  列条目名时 filter 一律返回 false，不解压内容。别改成整包 `unzipSync`——六个包全展开是白给的内存。
- 自定义方案 `airship://<id>` 下，`blob:` 的 URL 不再被 `'self'` 覆盖：foliate 注入的章节样式表是
  `blob:airship://books/…`，`style-src` 不写 `blob:` 就被拦掉（2026-11-07 截图走查抓到过一次）。
- 用例的包根工装在 `src/shell/tests/helpers/packages.ts`：把仓库真清单落成临时包根并设 `AIRSHIP_APPS_ROOT`。
  壳现在运行期扫包，没有这一步所有问注册表的用例全空——**空表不算通过**，`AP-008` 钉着这条。
- `templates/app/` 是给别人复制的范本，**不参与** `just casecov` 的双向差集，也不被 vitest 跑
  （两处都按目录名 `templates` 排除）；复制进 `src/apps/<id>/` 之后才归这套规矩管。

## 沟通

全中文。只答被问的那件事，别顺带交付额外的文书、全景或多方案矩阵；延伸只留一句提问。
**提交由使用者发起**——改完停在"未提交"，除非他明说提交。
