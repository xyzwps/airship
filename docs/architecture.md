# airship 架构

这份文档讲**为什么这样搭**，以及搭的时候撞过哪些坑。
用户可见的契约（界面上读得到哪句话、落盘文件是什么形状）在规格册里，索引见 [specs/index.md](specs/index.md)；
还没做 / 做不了 / 这期不做的事，唯一的一份在 [todo.md](todo.md)。这里不抄那两处的内容，只讲结构与依据。

## 1. 系统组成

飞船是一个 **runtime + 外挂应用** 的结构，像 JVM / .NET 那样：运行时只装一份、大家共用，
应用是各自独立安装、各自带一个启动快捷方式的小包。

```
airship runtime（一个 Electron 进程，src/runtime/，@airship/runtime）
  ├─ 主进程：注册命令行指来的包、开窗口、能力实现、包协议、单实例转发
  ├─ preload：只暴露 window.airship 这一面
  └─ 没有自己的界面：不画启动器，不扫磁盘找应用

应用（八个，src/apps/<id>/，各自一个 airship 包）
  airship-reader Reader · airship-dago Dago · airship-life-game Life Game
  airship-ffmpeg FFmpeg · airship-wsld WSLD · airship-svg-editor SVG Editor · airship-s3 S3 · airship-icon 图标工坊
  每个应用 = <id>.airship 归档 + 它自己的每用户安装器 + 一枚快捷方式
```

runtime 装一次，钉死在 `~\.airship\runtime`（每用户，不要管理员）。
应用由**它自己的安装器**装进同一棵树的 `~\.airship\apps\<id>\`（同样不要管理员），
安装器在桌面与开始菜单留一枚快捷方式，目标就是 runtime 的 `airship.exe` 加上那份包的绝对路径。
双击快捷方式 → runtime 注册那份包 → 开出这个应用的窗口。

**runtime 不认识任何具体应用。** 跑哪些包由命令行决定（`airship.exe <id>.airship`，可以一次指多份），
注册一份、开一个窗口；没带包路径就念一句用法退出，不存在"开一个空启动器等人挑"这条路。
安装包的产物里没有一行应用代码，runtime 自己也没有渲染目标。加 / 更新 / 卸一个应用都不动 runtime。

一个应用一个窗口一个渲染进程。应用只能通过 `window.airship` 碰系统，能碰什么必须先在自己的清单里声明。
多个应用共用**一个 runtime 进程**：第二次启动把包路径转发给已在跑的那一份（见 §3）。

代码分五个区，方向不许反（见 §4）：

| 区 | 包名 | 管什么 |
|---|---|---|
| `src/runtime` | `@airship/runtime` | 主进程、preload、窗口、能力实现、包协议、单实例转发 |
| `src/sdk` | `@airship/sdk` | 宿主（标题栏 / 主题落地 / 留白 / 占位）、图标键、CSP、工装钩子；将来独立发布的那一份 |
| `src/apps/<id>` | `@airship/<id>` | 八个应用，各自自持 `index.html` + `main.tsx` |
| `src/shared/contract` | `@airship/contract` | 契约、清单类型、拒绝措辞、注册与包形状的规矩 |
| `src/shared/library` | `@airship/library` | 共享书库（Reader 管的那一份） |
| `src/shared/textdecode` | `@airship/textdecode` | 中文解码 |

## 2. 七条不变量

这几条是"不照做就会做错"的硬约束，多数有册子编号或用例守着。

- **I-1 一个应用一个窗口一个渲染进程。** 隔离是窗口化真正买到的东西：一个应用崩了不带崩别人，
  改一个应用不用管其余七个。
- **I-2 应用只能通过 `window.airship` 碰系统。** 看不到 `ipcRenderer`，也拿不到绝对路径以外的系统面；
  能碰什么由清单 `capabilities` 声明，没声明的一律拒绝并给出读得懂的原因（措辞在 `@airship/contract`）。
- **I-3 身份由 runtime 绑定注入，应用冒充不了别人。** preload 从启动参数注入 id，
  主进程再用 `event.sender` 反查归属二次确认。应用代码从不传自己的 id。
- **I-4 数据由 runtime 统一托管。** 各应用的数据落在 `~\.airship\data\<id>\` 下它自己那一族，
  应用不自己挑落盘位置。共享数据区（书库）由 runtime 创建与托管。
- **I-5 加一个应用不改 runtime 侧任何文件。** 名单来自命令行指来的包，不是写死的 id 表。
  契约层刻意不维护 id 名单（`AppId = string`，运行期校验）。这条有 AP-010 守着：
  runtime 产品代码里不许出现具体应用 id 的字面量。
- **I-6 应用与 SDK 不许 import runtime。** 边界由 node 的解析器守（说明符一律写包名 `@airship/...`），
  不靠注释。AP-013 守着这条。壳给应用窗口的 DOM 只有 SDK 那一份。
- **I-7 子进程只跑 runtime 发现的东西。** proc 白名单的来历只有一个：runtime 按工具登记表发现的
  （含环境变量显式指的那一档）。应用既不能自己找一个来跑，也不能借 runtime 发现的名义跑没声明的工具。

## 3. 进程与窗口模型

**单 runtime 进程。** 所有应用窗口住在同一个 Electron 主进程里，各自一个渲染进程。
没有启动器窗口，runtime 自己不画任何界面。

**启动流程**（`src/runtime/main/index.ts`）：

1. `app.setName('airship')`（否则 Electron 的默认名取 package.json 的 `@airship/runtime`，日志与外壳身份都念得难看）
   + `app.setPath('userData', profileDir())` 把浏览器档单独钉到 `~\.airship\profile`。
   **数据布局不跟 userData 走**——paths.ts 是从 `airshipHome()` 派生的，改任何一边都要想到另一边。
2. 抢单实例锁，**在 `whenReady` 之前**：`const GOT_LOCK = SHOT_MODE || app.requestSingleInstanceLock()`。
   抢不到不是错误——argv 会由 Electron 自动交给第一实例的 `second-instance`，这次直接 `app.quit()`。
   `whenReady` 首行 `if (!GOT_LOCK) return`：不然第二实例也会把启动跑完、开出一扇重复的窗再退出
   （真机抓到过：两扇 airship-dago 各开一次）。
3. `whenReady` 里：挂包协议处理器、注册 IPC、把子进程事件接到"只投归属窗口"的路由上。
4. 从 argv 挑出 `.airship` 结尾的包路径（`archivesFromArgv`，相对路径按 cwd 解）。
   一份都没有 → 念用法（`usageLine()`）+ `app.exit(1)`，不开任何界面。
5. 逐份 `registerPackage(archive)`：读归档里的清单、校验形状与引用边界、装进**活动包表**。
   不合格响亮退出（弹错误框 + exit 1），不静默少一个窗口。
6. 逐份 `runPackage`：`openAppWindow(id)`（授权已在安装期完成，PK-033；直跑不再弹确认卡片）。
   一个窗口都没开出来（全都开失败了）→ `app.quit()`，没有理由继续占着进程。

**活动包表是进程级的，只装 argv 指来的那几份包**（`packageRegistry.byId` Map），不扫磁盘。
"这台机器上装了哪些应用"不是 runtime 要知道的事——它只知道"这次被要求跑哪些包"。

**单实例转发**（`second-instance`）：第二次启动的 argv 转发给已在跑的那一份。
相对路径按**第二实例的 cwd** 解（Electron 把对方的 cwd 一并交过来），快捷方式给的是绝对路径不受影响。
同 id 同归档 → `registerPackage` 返回表里那一份，`openAppWindow` 聚焦；
同 id 异归档 → 拒（措辞在契约层）；新包 → 直接开窗口。

**授权在安装期一次完成**：应用安装器装前念能力清单（`capabilitiesPhrase`，PK-033），
装完双击快捷方式直接开窗口，不再弹确认。从前那张"首次直跑陌生包"的能力确认卡片
（`runConfirm`，PK-027~030）于 2026-11-19 退场——双击应用先弹一张卡片太烦，
而装的时候已经念过清单、点过确定，授权那一刻就完成了。`run-confirm.json` 随之删除。

**窗口**（`src/runtime/main/windows.ts` 的 `openAppWindow`）：无边框（`frame: false`，标题栏由 SDK 画），
尺寸只认清单（没写就跟 runtime 默认 1100×740），位置不记、每次由系统摆。
台账（`windowLedger`）判"开新的还是聚焦旧的"：同 id 已开着就聚焦，不重开。
平台不支持的应用（清单 `platforms` 不含本机）根本不开窗口，响亮念出原因。

**事件只投归属窗口**（`routing.ts` 的 `targetsFor`）：子进程进度、托盘点击这类事件只回到归属那个窗口，
没有全局广播。窗口没了事件就丢弃。这条抽成纯函数是为了能被测试——隔离的最后一环就是它。

**任务栏身份逐窗口给。** `windows.ts` 在建窗之后调 `setAppDetails({ appId, appIconPath, relaunchCommand,
relaunchDisplayName })`（win32 专有；后两条必须成对，否则外壳两条一起忽略）。从前那句
`window.setAppUserModelId?.(...)` 是假绿——方法只挂在 `app`（进程级）上，BrowserWindow 没有，可选链把失败
吞成空操作，八个应用仍共用 `dev.xyzwp.airship` 一个身份。现在 `appId` 是 `dev.xyzwp.airship.<id>`，
图标取包根那份随包备好的 `icon.ico`（PK-036）落到 `~\.airship\icons\<id>.ico` 交给外壳——
外壳只认磁盘上的 `.ico`，asar 与 `airship://` 它不认；包里缺那一份时身份照样分开、只回落 runtime 的图标并在日志念一句。
判据在 `runtime.md` 的 SH-010 / SH-034 / SH-035。**还没做的那半件**：`.lnk` 上没有 per-app 的 AUMID
（NSIS 裸 `CreateShortCut` 写不了 `System.AppUserModel.ID`，那要 ShellLink 插件），记在 todo.md TD-001。

**崩溃隔离**：一个渲染进程崩了不带崩主进程与别的窗口。主进程的未捕获异常 / 未处理拒绝写日志不致命。

**关窗收尾**：`window-all-closed` → 收掉所有子进程、清托盘、退出（非 macOS）。
截图模式例外——它逐个开窗、关窗再下一个，生命周期由 `runShotMode` 自管（末尾 `app.quit()`），
`window-all-closed` 在截图模式下直接 return，否则截完第一个就退出（启动器退场后抓到的一次回归）。

### 3.1 实测数字

性能按**用户可感知的指标**报，并且要有实测数字。`just shot` 逐窗口截图时顺手打两行：
`[metrics]` 是每窗口的工作集（趁窗口还开着采样，关掉之后就没有这个数字），
`[perf]` 是首屏挂载耗时（`mountMs`，从开窗口到渲染侧报就绪）与若干标记。
截图模式整份家换到 `~\.airship-shot`（数据与浏览器档都不碰日常那一份），逐个开窗、按下快门、关掉再下一个，
所以每个数字是那一扇窗在隔离状态下的，不是八扇全开的累计。

本轮（2026-11-19，`just shot`，编译后的 runtime 产物直跑，DPI 1.5）：

| 窗口 | 工作集 | 首屏挂载 |
|---|---|---|
| Dago | 86 MB | 155 ms |
| Reader | 100 MB | 507 ms |
| WSLD | 99 MB | —（wslc 定位 535 ms） |
| Life Game | 102 MB | — |
| SVG Editor | 112 MB | — |
| S3 | 102 MB | 540 ms |
| FFmpeg | 102 MB | 540 ms |

工作集八扇都有；首屏挂载只有报了就绪标记的那几扇有数字（Life Game / SVG Editor / WSLD 本轮没报挂载标记，
WSLD 报的是"wslc 已定位"那条）。EPUB 翻页延迟没单独采样（TD-012）——现在只有"打开到首屏"的数字。
界面观感（真排版好不好看）靠 `just shot` 截图走查，产物不入代码库。

## 4. 分层与依赖方向

```
应用（src/apps/<id>）  ──依赖──▶  SDK（src/sdk）  ──依赖──▶  契约（src/shared/contract）
       │                            │                            ▲
       └──────依赖──────────────────┴────────────────────────────┘
                                    │
                          共享包（library / textdecode）──依赖──▶ 契约
runtime（src/runtime）──依赖──▶ 契约 + SDK（宿主那一份 DOM）
```

方向不许反：

- **应用与 SDK 不许 import `src/runtime/**`**（AP-013）。runtime 也不 import 任何具体应用——
  名单来自命令行指来的包。这条由 node 的解析器守：说明符一律写包名（`@airship/...`），
  手写别名已全部拆掉。
- **契约层是最底下那份**，谁都可以依赖它，它不依赖任何上层。能力位、清单类型、拒绝措辞、
  注册与包形状的规矩都在这。`protocol.ts` 是 runtime 与应用之间的能力契约（`AirshipBridge`），
  这是 airship 唯一重要的文件：应用能做什么全部由这里声明，preload 只按这张表暴露，主进程只按这张表实现。
- **共享包属于依赖图的下层**，反过来依赖 runtime 的界面代码就破了自己定的规则。
  所以 `AppApi`（契约 + 自己的 id）放在契约层而不是 runtime 的 UI 层。
- **SDK 是将来要独立发布的那一份**，改它的导出等于改公开面（TD-013）。
  runtime 给应用窗口的 DOM 只有 SDK 那一份——`src/runtime` 里没有 `AppHost`，也没有 `app.html`。

每个区都是一个 npm workspace 包。根 `package.json` 只声明 `workspaces`，**没有 scripts**；
命令只走 justfile。各包的 SDK 与 react 记在 `devDependencies`——它们被构建进包，
运行时不需要机器上装着（AP-016 钉这条）。

## 5. 契约桥

### 5.1 契约（`src/shared/contract/protocol.ts`）

`AirshipBridge` 声明应用能碰的全部面：`paths` / `theme` / `setTheme` / `settings` / `dialog` /
`fs` / `proc` / `tools` / `backend` / `tray` / `notify` / `clipboard` / `log` / `window` / `on`。
**没有 app 参数**：身份由该窗口的 preload 从启动参数注入，主进程再用 `event.sender` 反查归属二次确认。
应用既看不到"传 id"这个动作，也就没法冒充别的应用。线格式（preload ↔ 主进程）仍然带 id，
那是实现细节，不进契约。

`AppApi = AirshipBridge & { id }`：id 只用于显示与日志，不参与任何权限判定。
`AppPaths.runtimeVersion` 是 runtime 版本。`SettingsScope = AppId`——runtime 自己不持有设置屏，
主题这类窗口观感也落在应用自己那份设置文件里（由 `theme:set` 这条窗口面通道写，不占 settings 能力）。

事件频道 `ShellEvent`：`proc:chunk` / `proc:exit` / `tray:click` / `window:maximized` / `backend:event` / `backend:exited`。
**没有 `theme:changed` 全局广播**——主题按应用各记各的（见 §10），不需要广播。

### 5.2 preload（`src/runtime/preload/`）

只暴露 `window.airship` 这一面，按契约表实现。没有启动器面（`airshipShell` / `apps()` / `InstalledApp`
那一族已随启动器退场）。渲染侧拿不到 `ipcRenderer`，也拿不到绝对路径——
路径只能由 preload 的 `webUtils.getPathForFile(file)` 换出来（拖文件进窗口时用）。

### 5.3 主进程 IPC（`src/runtime/main/ipc.ts`）

按契约表实现每个方法，按 `event.sender` 反查归属再查能力表。没声明的能力一律拒绝，
错误措辞由 `@airship/contract` 的 `errors.ts` 供（中文句子原文，不出现 "Error invoking remote method"
这类 Electron 内部措辞）。问了 runtime 不认识的工具，日志喊"问了 runtime 不认识的工具"。

### 5.4 拒绝措辞单一真源

能力位的界面说法（`CAPABILITY_LABEL`）与人话摘要（`capabilitiesPhrase`）都在契约层。
应用安装器的安装页念它——**界面上不许再抄一遍**。
空清单念"不碰你的文件"，而不是念一个空字符串。

### 5.5 SDK 的 API 钩子

应用侧用 `useAppApi()`（`src/sdk/api.ts`）拿到 `window.airship`。它不存在时响亮念出
"这个包不是由 airship runtime 打开的，或 preload 没加载成功"，而不是静默空操作。
正常入口是 runtime 按 `airship://<id>/index.html` 开窗口。

## 6. 能力与授权

`capabilities` 是唯一授权面，没声明的一律拒绝；用不到就写 `[]`（airship-life-game 就是这么起的）。
用了 `api.settings.` / `api.proc.` 这些域就必须声明对应能力，AP-011 会扫。

| 能力位 | 管什么 |
|---|---|
| `fs.read` | 读文件：限应用数据目录内，或本次会话中用户通过系统对话框显式选中的路径 |
| `fs.write` | 写文件：限应用数据目录内 |
| `dialog` | 弹系统文件/目录选择框（选中结果自动进入本应用的可读路径集合） |
| `settings` | 读写本应用命名空间下的设置项 |
| `shared` | 访问 runtime 级共享命名空间（具体哪几个由清单 `sharedNamespaces` 声明） |
| `proc` | 派生子进程并接收 stdout/stderr 流 |
| `tray` | 托盘图标与提示文字 |
| `notify` | 系统通知 |
| `clipboard` | 剪贴板 |
| `log` | 写日志（按应用分命名空间） |

**`net` 能力位已于 2026-11-24 整族退场**（连同按它放宽的 CSP 档与窗口同源豁免，判据注记见 `bridge.md` BR-011
与 `app-model.md` AP-017 末尾）。它当初是为对象存储一个应用开的口子：端点响应里没有跨源许可，runtime 代发就得伪造响应头。
退场的路线不是把口子收紧，而是把整段网络活搬出窗口——应用随包自带后端进程（下面一段），
SDK 的流式上传与分块下载在后端进程的 HTTPS 模块上照跑，渲染侧既不发请求也不碰盘，CSP 与同源策略一概不需要为谁放宽。

**后台程序不是能力位，也不进清单**：能力位收的是宿主代管的资源（文件、剪贴板、进程……），
而"随包自带一段 Node 代码"是包的构成物——像原生应用自带的线程，不是向外求的授权。
有它靠约定：源项目在应用目录平铺一份 `backend.ts` 或 `backend.js`，产包流水编成包根 `backend.js`
（PK-040/041）；runtime 在包里见到那个条目才起进程（`backend.md`）。
该让人知道的是安装期的那一眼：安装器欢迎页在能力清单末尾念「跑它自带的后台程序」，措辞从包形状读（PK-033）。

### 6.1 路径授权（`grants.ts`，GR 册）

五条规则，会话内有效：应用数据目录内随便读写；数据目录外只读用户本次会话通过对话框显式选中的路径；
`dialog` 选中的文件自动进入可读集合（`grantParentDir` 可连父目录一起授，给 airship-ffmpeg 那种"输出落在源文件同目录"用）；
共享命名空间要清单声明；越界直接拒。授权是会话级的，进程退出就没了。

### 6.2 共享命名空间

`SHARED_NAMESPACES = ['library']`，这份名单**属于 runtime**：目录由 runtime 创建与托管，
新增一个共享数据区是 runtime 的功能变更，不是应用变更。书库开成共享命名空间，是因为它曾由墨读与 PDF 两个入口共用
（PDF 已于 2026-11-26 退场，机制留着）——各自存一份就会"同一本书在两个入口里各有一本"。
应用只能在清单里声明自己要访问哪个，声明了不存在的直接拒。

### 6.3 工具发现（`tools.ts`，PT 册）

`TOOL_NAMES = ['ffmpeg', 'wslc']`，这份名单同样**属于 runtime**：怎么发现、拿什么标志校验它是真的，
是 runtime 的能力，不是应用的说法。发现顺序三档：

1. **环境变量显式指**：`AIRSHIP_<NAME>_PATH`（如 `AIRSHIP_FFMPEG_PATH`）。
2. **PATH**：在 PATH 里找。
3. **已知位置**：内置表里那几个常见落点（如 `C:\Program Files\WSL\wslc.exe`）。

**没有"用户指定"那一档**（整档删了）：从前启动器设置屏里那颗"手动指一个路径"的键随启动器退场，
要显式指就走环境变量。应用既不能自己找一个来跑，也不能借 runtime 发现的名义跑没声明的工具。
工具发现结果在启动第一份日志里就能读到"可用/不可用"。

### 6.4 子进程（`proc.ts`）

白名单的来历只有一个：runtime 按 §6.3 发现的。`proc.run` 一次性跑完拿结果（探测类短命令），
`proc.start` 后台跑、进度通过 `proc:chunk` / `proc:exit` 事件回流到本窗口，`proc.kill` / `proc.list` 管生命周期。
关窗与退出时 `proc.killAll()` 收掉所有子进程。

## 7. 应用模型

### 7.1 清单（`app.ts`，纯数据）

一个应用该有的文件：`package.json`、`app.ts`（纯数据清单）、`index.html`（入口文档，引 `./main.tsx`，
**里面不写 CSP**）、`main.tsx`（一行 `createAirshipApp({ meta, component, icon })`）、
`icon.png`（**只认这一张源图**，不套底板，颜色烘进图里；svg / jpg / jpeg / webp 于 2026-11-26 退场）。
外加 `icon.ico`（任务栏那颗外壳图标，作者自备的多尺寸 16~256，产包只搬不转）。缺哪件产包期炸哪件，标准见 [docs/apps/icon.md](apps/icon.md)。

清单只写"这个应用自己的事实"：`id / name / description / capabilities / platforms / tools /
sharedNamespaces / flush / defaultWidth / defaultHeight`。**不写** `iconPath`、`order` 这类表现或关系字段
（都被驳回过）——图标是文件约定（包根那张图），排序不存在（没有启动器格子要排）。

### 7.2 包格式（`src/apps/specs/package.md`，PK 册）

归档文件名 `<id>.airship`——里面是一个 zip，条目名就是包内路径。`manifest.json` 由产包器从 `app.ts` 投影，
带 `schemaVersion` 与 `sdkVersion`。id 的形状、引用不许越出包：**判据只有 `@airship/contract` 那一份**
（`packageRules.ts`），产包侧与 runtime 注册侧调的是同一批函数。从前"两侧各写一份、用例比对输出钉相等"
（`code/pack-app.mjs` 是 `.mjs`，Node 解不开本仓 TS 里那种不带扩展名的相对 import，`.mjs` 引不了 `.ts`）
随 contract 编译成 `dist/` 一起退场了——产包流水本体现在住在 `@airship/cli`，仓库内外的包出自同一份实现。
被 Node 直接加载的源码包（`@airship/sdk`、`@airship/contract`）内部相对 import 仍**必须写扩展名**（`./csp.ts`），
编译期由 tsc 改写成 `./csp.js`。

### 7.3 注册与安装

**运行期注册 = 命令行指来的包。** runtime 启动时从 argv 挑出 `.airship` 路径，逐份读归档清单、
校验形状与引用边界、装进活动包表（进程级 Map）。**不扫磁盘**，没有"包根"那回事——
从前启动器扫两个包根（开发根 + 自装根）得到名单那一族已随启动器退场。
"这台机器上装了哪些应用"由应用安装器与操作系统管，runtime 只知道"这次被要求跑哪些包"。

**应用安装器**（`code/make-app-installer.mjs`，PK-031~035）：每个应用一个每用户的 `setup.exe`
（`release/apps/<id>-Setup-<版本>.exe`），NSIS `RequestExecutionLevel user`（不要管理员）：

- 落点 `$PROFILE\.airship\apps\<id>`，把那份 `<id>.airship` 放进去（runtime 与应用同在一棵 `~\.airship` 树下）。
- `.onInit` 先找 runtime：`AIRSHIP_PATH` 环境变量优先，否则 `$PROFILE\.airship\runtime`；
  找不到就念一句"没找到 airship runtime"（`runtimeNotFound`，措辞在契约层）中止，不装。
- 安装页念这个应用要的能力清单（`capabilitiesPhrase`，契约层单一真源），`MB_OKCANCEL` 确认。
- `CreateShortcut` 桌面 + 开始菜单各一枚：目标 runtime 的 `airship.exe` + 引号包路径 + 应用的 `icon.ico`。
- HKCU 卸载项。`Section Uninstall` 删安装目录、两处快捷方式、注册表，**不碰**同一棵树里 `~\.airship\data\<id>` 的数据。
- 界面走 MUI2 向导（欢迎 / 进度 / 完成 + 卸载三页，简中+英文）：欢迎页念安装目录，进度页不刷日志，
  完成页点「完成」直接关窗；图标用包内那张 `.ico`。能力确认仍是 `.onInit` 里那张 `MB_OKCANCEL`。

**没有拖装那条路了。** 从前"把归档拖到启动器上就装进自装根"那一族（PK-015~020 的拖装半段、
启动器顶栏管理键的卸载记号）随启动器退场。装包只有一条路：跑应用自己的安装器。
runtime 侧不再有扫包、拖装、启动器卸载的代码。

### 7.4 生命周期

装（应用安装器，念能力清单）→ 双击快捷方式 → runtime 注册 + 开窗口 → 用 → 关窗（收子进程、清托盘）→
最后一个窗口关掉则 runtime 退出。卸（应用安装器的卸载段）只删安装目录 / 快捷方式 / 卸载项，数据留着。
更新一个应用 = 重跑它的安装器（同 id 覆盖那份归档），不动 runtime。

### 7.5 八个应用

| id | 名称 | capabilities | tools | 平台 | flush | 默认尺寸 |
|---|---|---|---|---|---|---|
| `airship-reader` | Reader | fs.read, fs.write, dialog, settings, shared, notify, clipboard, log | — | 全 | 是 | 600×800 |
| `airship-dago` | Dago | dialog, settings, tray, notify, log | — | 全 | 是 | 600×800 |
| `airship-life-game` | Life Game | （空） | — | 全 | 是 | 1000×720 |
| `airship-ffmpeg` | FFmpeg | fs.read, fs.write, dialog, settings, proc, notify, clipboard, log | ffmpeg | 全 | 是 | 默认 |
| `airship-wsld` | WSLD | fs.read, fs.write, dialog, settings, proc, notify, clipboard, log | wslc | windows | 是 | 默认 |
| `airship-svg-editor` | SVG Editor | settings, dialog, fs.read, fs.write, clipboard | — | 全 | 是 | 1440×900 |
| `airship-s3` | S3 | settings, dialog, clipboard | — | 全 | 是 | 1180×760 |
| `airship-icon` | 图标工坊 | dialog, fs.read, fs.write | — | 全 | 否 | 720×780 |

`airship-dago` 与 `airship-s3` 各自带一份 `backend.ts`，产包后进包根 `backend.js`：盘的活与网络活都在自带的后端进程里做，
窗口的清单不再为它们要 fs 或外连的口子（§6 末尾与 `backend.md`）。

从前 books 与 pdf 都声明 `sharedNamespaces: ['library']` 共用同一份书库；PDF 退场后只剩 airship-reader 这一个消费者。
"默认"尺寸 = runtime 的 1100×740。`flush` 是 SDK 宿主给不留白（应用自己铺满整窗）。

## 8. 包协议与文档加载

自定义方案 `airship://<id>/<entry>`：一个应用的文档面只读到它自己那一个包。
方案属性在 `app ready` 之前注册，处理器在 `whenReady` 里挂（Electron 要求）。
窗口加载 `airship://<id>/index.html`，EPUB 的章节样式表是 `blob:airship://airship-reader/…`。

**CSP 的一个坑**：`airship://` 下 `blob:` 的 URL 不再被 `'self'` 覆盖——foliate 注入的章节样式表是
`blob:airship://airship-reader/…`，`style-src` 不写 `blob:` 就被拦掉（2026-11-07 截图走查抓到过一次）。
CSP 由 SDK 产包时注入（产包一条、开发一条，不再按清单分档——`net` 退场的事，见 §6），应用的 `index.html` 里不写 CSP。

归档读取用 fflate（`@airship/runtime` 的依赖）：`unzipSync(data, { filter })` 只解需要的那个条目，
列条目名时 filter 一律返回 false，不解压内容。别改成整包 `unzipSync`——八个包全展开是白给的内存。

## 9. 数据与存储

全部在 `~\.airship` 这一棵树里（布局真源 `src/runtime/main/services/paths.ts`；整棵树可换家：
`AIRSHIP_HOME` 指哪就是哪，dev 用它把窗口数据隔离到项目里的 `.airship-dev/<id>`，截图模式整份落到 `~\.airship-shot`）：

```
~\.airship/
  runtime/                     runtime 自己的安装（主 exe 是 airship.exe）
  apps/<id>/<id>.airship       应用安装器放进去的那份包
  data/<id>/settings.json      应用私有设置（含它自己的主题档）
  data/<id>/                   应用私有数据（扁平：文件直接放这一层）
  data/<id>/cache/             可随时整体删除重建（所以 cache 是保留名）
  data/<id>/backend/           随包后端的影子 backend.cjs
  shared/library/              共享书库（Reader 的那一份）
  icons/<id>.ico               交给外壳的那张任务栏图标
  logs/                        按日期的日志
  profile/                     Electron 自己的浏览器档（userData 开局就钉到这里）
```

**没有 runtime 级的 settings.json 了**：从前壳级那份（全局主题、工具手动路径）随启动器退场——
主题按应用各记各的（落在 `data/<id>/settings.json`），工具手动路径那一档整档删了（要显式指走环境变量）。

目录布局只依赖 airship 家的根与 id，**不需要知道"现在有哪些应用"**。这条是踩过来的：
原来 `build()` 会遍历当时的注册表建一张 `apps` 表并缓存，一开机就读失败。

落盘原子写（写暂存名再改名），坏文件挪成 `.bad` 不致命（ST 册）。
应用安装器卸载不动这份数据；runtime 卸载也不动（`deleteAppDataOnUninstall: false`）。

## 10. 界面与主题

runtime 自己没有界面。应用窗口的 DOM 只有 SDK 那一份宿主：标题栏、主题落地、窗口留白、占位图。
应用作者只写自己的正文，标题栏中段念"正在看什么"（书名是应用内容，不是窗口名字）。

**主题按应用（决定 A）。** 三档（亮 / 暗 / 跟随系统）由 SDK 标题栏那颗主题键改，
措辞照搬从前启动器那颗。各应用各记各的，落在它自己那份 `settings.json`，
由 `theme:set` 这条窗口面通道写，不占应用的 settings 能力。
"跟随系统"的亮暗判定在 SDK 用 `matchMedia` 算（主进程没有 matchMedia，不该去猜），
`setTheme(mode, resolvedHint)` 把算好的亮暗传进来。**没有 `theme:changed` 全局广播**——
从前启动器改一次全局主题、所有窗口跟着换那一族退场了，现在改一个应用的主题不影响别的。

没有应用列表 / 启动器格子（`airshipShell.apps()` 那一面已退场）。开哪个应用由快捷方式决定。

## 11. 可观测性

日志按天分文件、按应用分命名空间（LG 册），行形状固定，写失败不致命。
启动第一份日志里念：版本、平台、userData、跑着的包、工具发现结果。
没有启动器设置屏那个诊断入口了（随启动器退场）；工具可用与否在日志里读，
`grants.stats` 供诊断与用例用。主进程未捕获异常 / 未处理拒绝写日志。

## 12. 构建与出包

命令只走 justfile（`package.json` 没有 scripts）。`just` 不带参数列出全部配方。

| 配方 | 做什么 |
|---|---|
| `just build-apps` | 产各应用的 airship 包到 `dist-apps/`（每应用一次独立构建） |
| `just compile` | 编译 runtime 的**两个**目标 → `src/runtime/out/{main,preload}`（先 `rm -rf out`） |
| `just dev <id>` | 直跑那一个应用：文档走 vite dev server（热更），清单与图标走包 |
| `just start <id>` | 跑构建好的产物（文档从包里加载，与装好的 runtime 最接近的一条路） |
| `just shot` | 逐窗口截图（先 compile + build-apps），打每窗口内存与首屏耗时 |
| `just app-installer <id>` | 产那一个应用的每用户安装器 → `release/apps/<id>-Setup-<版本>.exe` |
| `just build-runtime` | 清场 → 编译 → NSIS → 自检 + 写 `.sha256`（runtime 安装包） |
| `just build` | 两条一起跑：产各应用的包 + 打 runtime 安装包（产物互不包含） |
| `just check` | 提交前一轮：类型 + 单测 + 册子差集 |
| `just new-app <id> <名>` | 从 `templates/app` 造一个新应用 |

**compile 只有两个目标**（main + preload），没有 renderer——runtime 不画自己的界面。
先 `rm -rf src/runtime/out` 再编：vite 只清它要写的那几个目标，旧时代留下的 `out/renderer`
不清就会一直躺着冒充产物（verify-installer 反过来钉 `out/renderer` 不该存在）。

**runtime 安装包**（`src/runtime/electron-builder.yml` + `build/installer.nsh`）：
`perMachine: false`（每用户，不要管理员），落点钉死 `~\.airship\runtime`——
目录的唯一真源在 `installer.nsh` 的 `customInit`（`StrCpy $INSTDIR "$PROFILE\.airship\runtime"`，
插在 initMultiUser 之后所以覆盖生效，升级时读到的旧 InstallLocation 同样被覆盖，"一定装在这个目录下"不向历史让步）；
`allowToChangeInstallationDirectory: false` 去掉换目录页。
产物名 `airship-runtime-Setup-<版本>-x64.exe`，主 exe 叫 `airship.exe`（`productName: airship`，应用快捷方式的目标就是它）。
runtime 自己没有界面：`createDesktopShortcut` / `createStartMenuShortcut` 都 false，只留控制面板卸载项（`airship runtime`）。
**纯 runtime**：`files` 只有 `out/**`、`package.json`、`assets/icon.png`、`assets/tray.png`，不带任何 airship 包。
根 package.json 已经没有 dependencies（foliate-js 记在 airship-reader 名下，是 devDependencies，
构建期打进包；pdfjs-dist 随 PDF 应用于 2026-11-26 一并退场），所以不再需要"排除某个 node_modules 目录"那几条。

**版本号规矩**（正式约定在 [version.md](version.md)）：根 `package.json` 与 `src/runtime/package.json` **保持一致**——它们是同一个发布物，
就该念同一个数（现 0.4.4）。安装包文件名与 exe 文件版本取 `src/runtime/package.json` 的 version
（出包项目根是 `src/runtime`）；包清单里的 `sdkVersion` 取 `src/sdk/package.json` 的 version
（`code/build-apps.mjs`）——那是 npm 发布线（基础包四件套 `@airship/contract`/`@airship/sdk`/`@airship/cli`/`create-airship-app`
一致演进）的版本，与安装器线的 runtime 版本是两本账，混着取等于清单在说谎。各应用自己的 `package.json` 版本**独立演化**，
不跟 runtime 跳。runtime 的 `package.json` 里 electron 写**固定版本**（`45.2.3`，不带 `^`）——
electron-builder 要按它取二进制，写范围会被拒。

**清场**两档由 justfile 钉：`clean-release` 整目录 `rm -rf release`，由 `build-runtime` 开头走——runtime 安装包与
`release/apps/` 那一族一起归零，所以单独打完 runtime 包之后应用安装器是空的，得重跑 `just installers`；
`clean-app-installers` 走 `code/clean-installer.mjs apps` 那一档，删 `release/apps/*-Setup-*` 那一族（exe / .sha256），
由 `installers` 在出全部安装器之前走。安装包名字只由 version 决定，
不 bump 就永远是同一个文件名；一次没写成安装包的运行会让上一次那颗原地留着冒充刚出的那版，
而应用名单是会变的——删掉的那个应用留下的旧安装器同样在冒充最后一次构建。
规矩：**宁可响亮报错没有，不许旧包冒充新包**。`rm -rf` 删不动时非零退出，出包第一步就断（脚本那一档的
5 次 250ms 重试不在这条路上）；`win-unpacked` 也一起删掉，它每次由 electron-builder 整体重写，删了不多花钱。
单独跑 `app-installer <id>` 不经过 `apps` 那档，只由生成器删自己那一枚同名旧包。

**自检**（`code/verify-installer.mjs`，`build-runtime` 以它收尾）看六件事：
对应版本的安装包在不在、像不像 NSIS 向导（MZ 头 + NullsoftInst 签名）、`.sha256` 写好没、
`win-unpacked` 主 exe（`airship.exe`）在不在、**安装包是不是纯 runtime**（`resources/` 里只有 `app.asar`
与 `elevate.exe`，不该有任何 airship 包）、**runtime 产物里没有渲染目标与启动器通道**
（`out/renderer` 不该存在，`out/main` 与 `out/preload` 里不该出现 `launcher:` 或 `airshipShell`）。

没有代码签名，第一次运行会被 SmartScreen 拦一道（TD-003）。
Electron 与 electron-builder 的二进制走 npmmirror（`.npmrc` 与 `build-runtime` 里显式带同名环境变量）。

## 13. 规格册与用例

四档结构（Purpose → Requirement → Scenario → WHEN/THEN），每条 Scenario 带稳定编号（`BK-032` 这种），
**只写可观察结果**：界面读得到哪句话、错误文案原文、交给外部 CLI 的命令行、落盘文件的形状。
不写实现——不出现类名、方法名、控件名。一条 Scenario ≤ 5 行，只锁一个不变量。

编号是稳定句柄：不复用、不重排；删除是显式动作，要说清这条契约为什么不再成立。
用例标题以编号开头，`just casecov` 做双向差集：册里有号没用例 = 未实现，用例挂了号册里没有 = 私测（禁止）。
界面观感不进册子，那是 `just shot` 截图走查的事。写不出可执行判据的期望别进册子，记到本文档对应小节。

册子共 **24 本**：runtime 8 本（bridge / grants / logging / proc-tools / runtime / storage / theme / tray）
+ 应用区 2 本（app-model / package）+ 共享 2 本（library / textdecode）+ 应用 12 本
（ffmpeg / reader / dago / life-game / svg-editor / s3 / icon 各一，wsld 五本）。索引见 [specs/index.md](specs/index.md)。

**替身住 SDK**（`@airship/sdk/testing` 的 `FakeAirship` 与 `mountUi`），不住 runtime 的测试目录：
应用不许引 runtime，用例也不能——否则"包自持"在测试里是假的，外部作者复制范本出去后拿不到同一个替身。
替身**只能实现真 API 面上存在的方法**。教训有两条：替身窗口写过 `setAppUserModelId`
（BrowserWindow 上根本没有这个方法），用例绿着而真机没生效（TD-001 那处假绿就是这么来的）；
`window.x?.()` 这种可选链会把"方法不存在"吞成静默空操作——缺什么要喊出来，别默默跳过。

jsdom 没有 2D canvas：画布类判据只断言文字、状态与几何数字，"真画出来了"归 `just shot`。
整面 `vi.mock('@airship/sdk', ...)` 会把 SDK 的其他导出一起抹掉（踩过：`useTheme` 凭空不见），
要部分替换就用 `vi.mock('@airship/sdk', async (importOriginal) => ({ ...(await importOriginal()), ... }))`。

用例的包工装在 `src/runtime/tests/helpers/`：把仓库真清单投影成包清单喂给注册工装（`setup.ts`），
铺活动包表。runtime 现在运行期注册命令行指来的包，没有这一步所有问注册表的用例全空——
**空表不算通过**，AP-008 钉着这条。包根每次 `mkdtempSync` 新开一个目录（`mkdtempSync` 在 `node:fs` 不在 `node:os`），
不按 pid 复用——Windows 上 `rmSync(force)` 会把"删不掉"咽下去，旧格式的残包留在原地，扫描就"安静地空着"。

`templates/app/` 是给别人复制的范本，**不参与** `just casecov` 的双向差集，也不被 vitest 跑
（两处都按目录名 `templates` 排除）；复制进 `src/apps/<id>/` 之后才归这套规矩管。

## 14. 已定与未尽

**已定**（这轮 runtime 化）：

- 不再有壳 / 启动器，取而代之的是 airship runtime，钉死装进 `~\.airship\runtime`（每用户，不要管理员）。
- 应用自己安装（每用户安装器），自动去 `AIRSHIP_PATH` 或固定目录找 runtime；装完留一枚快捷方式当启动程序。
- 单 runtime 进程 + second-instance 转发；启动程序是快捷方式（.lnk，不是 stub exe）。
- 设置页与 runtime 级主题切换整族退场；主题按应用各记各的，由 SDK 标题栏那颗键改（决定 A）。
- 工具"用户指定"档整档删，发现顺序 `AIRSHIP_<NAME>_PATH` > PATH > 已知位置（决定 B）。
- clean break：不写旧数据迁移 / 兼容垫片。

**未尽**（细节与理由都在 [todo.md](todo.md)，这里只留状态标记）：

- TD-001 快捷方式（`.lnk`）上还没有 per-app 的 AUMID；窗口身份那一步已落（SH-010 / SH-034 / SH-035，见 §3）。
- TD-003 没有代码签名证书；TD-004 没有自动更新链路；TD-005 想要 Inno Setup 那一档观感。
- TD-006 多窗口的内存回收（现在没有触发这件事的症状）。
- TD-008~010 airship-wsld 原版有、这期先没有的三块（registry mirror / 拉取实时进度 / 自己的设置页）。
  （TD-007 run 编排已于 2026-11-20 落成，册子 `airship-wsld-run.md`，编号 RB-001~053 除显式删除的 026、053。）
- TD-012 EPUB 翻页延迟没单独采样。
- TD-013 SDK 独立发布与版本协商；TD-014 装包的来源信任、更新与商店链路。

**明确不做**：stub exe、每应用独立进程、旧数据迁移、商店与版本协商（TD-013/014 挂着）；
`iconPath` / `order` 是被驳回的清单字段，不改口。

## 15. 术语

- **runtime**：那个共享的 Electron 运行时（`@airship/runtime`），装一次大家共用，自己没有界面。
- **包 / airship 包**：一个应用的归档 `<id>.airship`（zip 换了扩展名），自持文档与清单。
- **能力 / capabilities**：应用清单里声明的授权面，没声明的一律拒。
- **桥 / bridge**：`window.airship` 那一面，应用碰系统的唯一入口。
- **宿主 / host**：SDK 给应用窗口的那份 DOM（标题栏 / 主题 / 留白 / 占位）。
- **册子 / spec**：用户可见契约的四档结构文档，用例是它的影子。
- **活动包表**：进程级的 Map，只装这次 argv 指来的那几份包，不扫磁盘。