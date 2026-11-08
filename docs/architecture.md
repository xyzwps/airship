# airship 架构

飞船是一个 Electron 桌面壳，把自用的多个应用装进同一个安装体里运行。本文描述**这个软件的架构**——组成、边界、规则与不变量；不描述某一轮施工计划。

代码：`Develop/airship`

状态标记：`[已实现]` 架构规定且代码已达到 · `[待达]` 架构已规定，实现尚未达到

当前进度（2026-11-06）：**§3 每应用独立窗口已落实**，能力边界是强制而非约定（身份由 preload 注入 + 主进程按 `event.sender` 反查归属，双重确认），七条不变量全部有测试或机制守住。
用户可见契约已按册子建档（册子与用例跟着代码放在各自区域，索引在 `docs/specs/index.md`），用例编号与册子双向差集由 `just casecov` 钉住。
本轮契约变化：拒绝措辞收进 `shared/errors.ts` 一份；清单新增 `platforms`（平台可用）与 `tools`（外部工具声明）；`tools.ffmpegPath()` 改为 `tools.path(name)`，工具发现做成内置表（ffmpeg / wslc）。实测数据见 §3.1。

---

## 1. 系统组成

**每个区都是一个 npm 包**（根 `package.json` 声明 `workspaces`），所以"谁可以引谁"由 node 的解析器执行，
不再靠四份手写别名表维持：

```
airship
├── 壳 src/shell/                    @airship/shell（private；main、version、electron-builder 配置都在这儿）
│   ├── main/          主进程：窗口管理、IPC、能力实现（存储/授权/子进程/托盘/工具发现）、
│   │                  运行期扫包（packageRegistry / packageRoots）、包的文件面（packageProtocol）
│   ├── preload/       桥：按契约白名单暴露 window.airship 与 window.airshipShell
│   ├── assets/        壳自己的图标（母版、icon.png、tray.png、icon.ico）
│   └── launcher.*     壳界面：只有启动器一份文档。应用窗口加载的是包自己的文档
├── SDK src/sdk/                     @airship/sdk：应用面向的那一面
│   ├── host / api / Titlebar / IconButton / theme / shot / autotest / trayIcon
│   ├── csp + cspPlugin（子入口 ./vite）· styles/airship.css（子入口 ./styles.css）
│   └── fakeAirship + mount（子入口 ./testing）——应用的测试替身住在这儿，不住在壳里
├── 应用 src/apps/<id>/              @airship/<id>：package.json + 清单 + 自持的 index.html + main.tsx + 一张图标
│                                    产出来是一个 zip 归档 dist-apps/<id>.airship
└── 契约与共享 src/shared/
    ├── contract/      @airship/contract：protocol / app / errors / registryRules / packageRules（依赖图最下层）
    ├── library/       @airship/library：墨读与 PDF 共用的那份书库
    └── textdecode/    @airship/textdecode：中文解码
```

四者关系一句话：**应用声明能力 → 壳按声明放行 → SDK 把契约接到界面上 → 共享包只通过入口暴露契约 → 数据由壳托管**。

目录按**角色**而不是按 Electron 的执行上下文切。理由：读代码的人关心的是"这是壳、这是 SDK、这是应用、这是共享"，而架构规则也是按角色表述的；上下文（main / preload / renderer）只在 `shell/` 内部再分，因为**特权代码只存在于壳里**——`apps/**`、`sdk/**` 和 `shared/**` 按契约全是渲染侧代码，这条不变量比按上下文切目录更强、也更好审计。

一个应用怎么被装进壳：`just new-app <id> [显示名]` 从 `templates/app/` 造出来 → `just build-apps` 逐应用构建并装成 `dist-apps/<id>.airship`（一个 zip 归档）→ 壳启动时扫包根得到名单。详见 §7.3 与 §12。

---

## 2. 不变量

架构成立与否只看这七条。破坏任何一条，系统就退化成"一坨共用代码"。

| # | 不变量 | 为什么 | 怎么挡 |
|---|---|---|---|
| I-1 | 应用之间不得互相 import | 否则改一个必须管另一个 | 边界测试扫 import 图 |
| I-2 | 应用只能通过 `window.airship` 触碰壳与系统 | 契约唯一入口，能力才可审计 | preload 不暴露 `ipcRenderer`；`contextIsolation` + `sandbox` |
| I-3 | 未声明的能力一律拒绝，且抛可读原因 | 静默降级会让边界形同虚设 | 主进程 `assertCap()` |
| I-4 | 数据由壳托管，应用不自选目录 | 卸载/清理/迁移只有一处真源 | 路径授权表 + `resolveInData/resolveInShared` |
| I-5 | 加一个应用不改动壳的任何文件 | 这是"独立演化"的最低门槛 | 清单自动发现 + 壳侧零应用字面量测试；已用 `apps/hello` 演练证实 |
| I-6 | 共享包不得含消费者专有概念；只有一个消费者的代码不进共享层 | 否则共享包被某个应用绑架 | 代码评审规则 + 消费者表由声明生成，可查 |
| I-7 | 子进程只能跑壳发现或用户显式指定的可执行文件 | `proc` 是最危险的能力 | 可执行文件白名单 |

---

## 3. 进程与窗口模型

**一个应用一个窗口，一个窗口一个渲染进程。** 这是架构基线，不是优化项：只有进程边界存在，§5 的能力表才是强制而不是约定，一个应用崩溃才不带崩别人。

```
主进程 (1)
├── 启动器窗口 (1)      壳自己的 UI：应用格子 + 设置那一屏（同一扇窗里换屏，不开新窗口）
└── 应用窗口 (0..N)     每应用一个；关闭即销毁其进程
```

| 方面 | 规定 | 状态 |
|---|---|---|
| 打开方式 | 点应用 → 新窗口；已开则聚焦，不重复开 | `[已实现]` |
| 平台可用 | 清单 `platforms` 不写 = 全平台可见；写了就只在列出的平台进格子，硬开被拒并说清原因 | `[已实现]` |
| 关窗收尾 | 应用窗口关闭 → 销毁进程 + 杀掉该应用名下的子进程 + 清它占的托盘 | `[已实现]` |
| 渲染进程 | 每窗口独立，`sandbox: true` | `[已实现]` |
| 崩溃隔离 | 一个应用崩溃只影响自己 | `[已实现]` |
| 任务栏 | 每应用一个独立身份，可单独固定与预览 | `[待达]` 现在那行调用是一次空操作（方法挂错了对象），四条改动缺一不可，见 [todo.md](todo.md) TD-001 |
| 事件路由 | 壳事件只投递给归属窗口；应用收不到别的应用的 `proc` 事件 | `[已实现]`，`tests/isolation.test.ts` 守住 |
| 身份注入 | 应用侧不传 id：preload 按启动参数绑定，主进程按 `event.sender` 反查二次确认 | `[已实现]` |
| 单实例 | 二次启动唤起已有启动器（启动器窗口已关就重建） | `[已实现]`，`tests/appWindowCreate.test.ts` 守住 |
| 窗口状态 | **不记**：宽高每次按清单 `defaultWidth/defaultHeight`（SH-015/016），位置每次由系统摆（SH-018）——换块屏幕不会把窗口丢到屏外 | `[已实现]` |
| 退出 | 关所有窗口 → 杀干净子进程 → 清托盘 | `[已实现]` |

### 3.1 实测数据

截图模式顺带采样（`[metrics]` / `[perf]` 两行），耗时都按"从该应用窗口打开算起"。

| 窗口 | 内存（空闲） | 内存（开着内容） |
|---|---|---|
| 启动器 | 85.1 MB | — |
| vcp | 101.1 MB | — |
| 墨读 | 98.0 MB | 163.9 MB（《第一推动》15 册套装） |
| PDF | 96.8 MB | 318.5 MB（2 页执照，125% 缩放） |
| 打勾勾 | 94.9 MB | — |
| 生命游戏 | 99.2 MB | — |
| 容器台 | 96.8 MB | — |

| 可感知耗时 | 数字 |
|---|---|
| 应用窗口挂载（热） | 134–167 ms |
| EPUB 打开到首屏渲染完 | 598–741 ms |
| PDF 首页出图 | 893 ms |
| vcp 探测一个 4K 文件 | 523 ms |
| vcp 批量入队 4 个（含逐个探测与字幕抽取） | 486 ms |

两批数字的来源：空闲内存与"挂载（热）"是 2026-11-07 拆包后端到端跑 `just shot` 采的
（七个窗口全开过一轮，`[metrics]` / `[perf]` 两行原文）；带内容那两列与四条 EPUB/PDF/vcp 耗时
是拆包前测的，还没在新架构下重采——**拆包改的是文档来源与构建方式，不改这些操作的路径**，
但没重采就是没重采，别当已验证。

结论：每个渲染进程约 95–101 MB 是窗口化的真实代价，六个应用全开约 600 MB。
架构接受这个代价换隔离；PDF 是内存大头（pdf.js 位图 + 画布），不是壳的开销。
拆包前后每窗口内存同档——多出来的那几 MB 是每包自带一份 React，不是壳变重了。

---

## 4. 分层与依赖方向

```
src/
  shared/
    protocol.ts        契约：能力、事件、AppApi、启动器面（含 apps() 与 InstalledApp）  ← 依赖图叶子
    app.ts             AppMeta + APP_ID_PATTERN（清单类型与 id 形状）                  ← 依赖图叶子
    errors.ts          拒绝原因的措辞        → 只依赖 protocol / app
    registryRules.ts   清单校验规矩          → 只依赖 protocol / app / errors
    packageRules.ts    包清单的形状判据      → 只依赖 app / errors（与 code/pack-app.mjs 各判一遍）
    library/index.ts   共享包：书库        → 只依赖 protocol
    textdecode/index.ts 共享包：中文解码    → 无依赖
  sdk/                 应用面向的那一面：host / api / Titlebar / IconButton / theme / shot /
                       autotest / trayIcon / csp + cspPlugin / styles/airship.css
  shell/
    main/              主进程：index windows ipc services/*（含 packageRoots / packageRegistry / packageProtocol）
    preload/           桥：身份注入、两套面、事件单频道
    Launcher.tsx …     壳自己的界面：只有启动器 + launcher.css + launcher.html
  apps/
    <id>/              每个应用：app.ts + index.html + main.tsx + icon.* + 组件与私有模块
```

包与包之间用 npm 名互相引用（`@airship/sdk`、`@airship/contract`…），由根 `package.json` 的
`workspaces` 建软链解析——**没有别名表**：2026-11-07 之前这里是四份手写配置
（两份 tsconfig、vitest、两份 vite 配置），拆掉之后边界由 node 的解析器执行，
`AP-013` / `AP-016` 与"旧别名不该回来"三条用例钉住它不再回去。
被 Node 直接加载的那几个源码包（`@airship/sdk`、`@airship/contract` 等）内部相对 import
**必须带扩展名**（`./csp.ts`），因为 Node 的 ESM 解不了省略写法；症状是拿到空模块而不是报错。

允许（单向）：

```
apps          ──→ sdk（宿主、观感、工装钩子）
apps          ──→ shared（契约类型与共享包）
sdk           ──→ shared
shell         ──→ sdk（启动器复用同一套标题栏与主题落地，不另画一份）
shell         ──→ shared
shell/main    ──→ 磁盘上的包（运行期读 manifest.json；不再 import 任何应用源文件）
```

主进程读清单是**必要的**：能力校验必须在主进程做，若由渲染侧把能力传过来，等于没有校验。
现在这条边跨的是进程与文件系统，不再是构建期——`app.ts` 由产包器投影成包根的 `manifest.json`，
主进程读的是那份 JSON。

禁止：`apps ↔ apps`、`shared → apps`、`shared → shell`、`apps → shell`、`sdk → shell`、`sdk → apps`、
应用绕过共享包入口 import 其内部文件、壳 import 某个应用目录内部。
前四条由 `tests/architecture.test.ts` 扫 import 图挡住（AP-013）。

`shared/protocol.ts` 与 `shared/app.ts` 是依赖图的叶子：只定义类型与常量，不 import 任何东西
（`app.ts` 反过来被 protocol 以 `import type` 引用，编译期擦除，不构成运行时环），
因此能被主进程、preload、渲染侧同时引用而不引入平台差异。
`shared/<包>` 只允许依赖同层与叶子，这条由 `tests/architecture.test.ts` 挡住。

---

## 5. 契约层（bridge）

契约文件 `src/shared/protocol.ts` 是整个系统最重要的一份文件：**应用能做的事全部由它声明，其余一概拿不到**。

### 5.1 暴露方式

preload 用 `contextBridge.exposeInMainWorld('airship', bridge)` 挂一个对象，`ipcRenderer` 本身不外泄。渲染进程拿不到 `require`、拿不到 `process`（`sandbox: true`）。

### 5.2 调用约定

所有跨进程调用返回信封 `{ ok, value } | { ok, error }`，由 preload 拆包：成功返回 value，失败抛 `Error(中文原因)`。应用侧就是普通 `try/catch`，不会看到 `Error invoking remote method` 这类 Electron 内部措辞。

**拒绝原因的措辞只有一份**：`src/shared/errors.ts`。主进程、启动器与测试替身都从这里取句子——
册子（`src/shell/specs/bridge.md`）钉的就是这些原文，各写各的会出现"测试绿着而真实界面念另一句"。

### 5.3 方法域

| 域 | 方法 | 需要的能力 |
|---|---|---|
| `paths` | 取本应用 data/cache 目录、共享区目录、平台、壳版本 | — |
| `settings` | `get / set / dump`，按作用域分文件 | `settings` |
| `dialog` | `openFiles / openDirectory / saveFile` | `dialog` |
| `fs` | `read / readRange / write / stat / list / ensureDir / remove / copy / resolveInData / resolveInShared` | `fs.read` / `fs.write` |
| `proc` | `run`（一次性）/ `start`（后台+事件）/ `kill` / `list` | `proc` |
| `tools` | `path(name)`：取壳已发现的外部工具绝对路径 | `proc`，**且**清单 `tools` 里声明过这一个 |
| `tray` | `set / clear` | `tray` |
| `notify` | `show` | `notify` |
| `clipboard` | `writeText / readText` | `clipboard` |
| `log` | `info / warn / error` | `log` |
| `window` | `minimize / toggleMaximize / close / isMaximized` | — |
| `on` | 订阅壳事件，返回退订函数 | — |

`fs.readRange` 存在的原因：EPUB/MOBI 是 zip，渲染器要随机访问其中片段。整本读进内存会让大书首开很慢，范围读把成本降到"用到才取"。

### 5.4 事件

单一频道 `airship:event`，按 `kind` 分发：`proc:chunk`（子进程 stdout/stderr 分块）、`proc:exit`、`tray:click`、`window:maximized`。一个应用的监听器抛错不影响其他应用。

### 5.5 应用侧的绑定

应用代码不传自己的 id：壳给每个应用注入一份已绑定身份的 `AppApi`（`shell/useAppApi.ts`），写起来是 `api.fs.read(path)`。主进程仍按 id 查能力表——身份由壳注入，应用改不了。

---

## 6. 能力与授权

### 6.1 能力位（11 项）

`fs.read` `fs.write` `dialog` `settings` `shared` `proc` `tray` `notify` `clipboard` `log` `net`

`net` 是其中唯一**不经过桥**的一项：应用在自己的窗口里用 `fetch` 直连外部服务（S3 兼容的对象存储），
壳按清单做两件事——产包时注入放宽了 `connect-src` 的那一条 CSP，建窗口时给那个窗口豁免同源策略。
不做成"壳代发请求"的接口，是因为对象存储的响应里普遍没有跨源许可（要按桶配 CORS 规则，
实测本机 RustFS 的预检回 200 却不带任何 `Access-Control-Allow-*`），代发就得伪造别人的响应头；
交回渲染侧才保得住 SDK 的流式上传与分块下载。判据见 `src/shell/specs/bridge.md` BR-011
与 `src/apps/specs/app-model.md` AP-017。

### 6.2 路径授权

1. 应用自己的 `data/`、`cache/`：自由读写。
2. manifest 声明过的共享命名空间目录：可读写。
3. 其余路径：必须本次会话中用户经系统对话框显式选中才给读；选中目录则后代可读。
4. 写只额外开放给"另存为"选中的那一个路径。
5. 授权仅进程生命周期内有效，重启清空，不持久化——避免越权残留。

`dialog.openFiles` 有 `grantParentDir` 选项，给"输出默认落在源文件同目录"这类应用（vcp）用；默认关闭，保持最小授权。

### 6.3 子进程与工具表

`proc` 只跑白名单内的可执行文件。白名单的来历仍然只有两个：**壳发现的**、**用户在设置里指定并通过 `-version` 校验的**。
"壳发现"的知识面是一张内置工具表（`main/services/tools.ts`）：每个工具一条，写着可执行文件名、PATH 之外的已知安装位置、
以及 `-version` 输出里必须命中的字样。当前表里有 `ffmpeg` 与 `wslc`。
应用侧只能问"我要用哪一个"（清单 `tools` 声明 + `api.tools.path(name)`），拿不到路径就跑不了，也就跑不了任意命令。

发现顺序对每个工具都一样：环境变量（`AIRSHIP_<NAME>_PATH`，工装用）> 用户指定 > PATH > 已知安装位置/额外手段。
新增一个工具是**壳的功能变更**（在表里加一条），不是应用变更：应用要新工具不改壳，前提是那个工具已在表里。

本机事实（已实测）：无系统 ffmpeg、无 ffprobe，ffmpeg 是 imageio_ffmpeg 带的静态 exe，因此媒体探测一律解析
`ffmpeg -hide_banner -i` 的 stderr；`wslc.exe` 由 WSL 3 自带，位于 `C:\Program Files\WSL\`。

### 6.4 边界的性质 `[已实现]`

能力校验、路径授权、子进程白名单都在主进程执行；每个应用又是独立渲染进程。
所以这张表现在是**强制边界**，不只是"你应该只用这些"：

- 应用侧根本看不到 `ipcRenderer`，也看不到 `airshipShell`（只有启动器窗口有）——它开不了别人的窗口。
- 调用里的应用身份由 preload 注入，主进程再用 `event.sender` 反查归属，两者不一致直接拒。
- 子进程事件只回到归属窗口；应用没开时事件被丢弃，不广播兜底。

这三条由 `tests/isolation.test.ts` 守住。

---

## 7. 应用模型

### 7.1 一个应用的全部对外形状

```
apps/life/
  app.ts          ← 纯数据清单：这个应用对外形状的全部
  index.html      ← 包自持的入口文档（不写 CSP，构建时注入）
  main.tsx        ← 一行：createAirshipApp({ meta: app, component: LifeApp, icon: './icon.svg' })
  icon.svg        ← 图标文件（png/jpg/jpeg/webp 也行，只能有一张）
  LifeApp.tsx     ← 组件本体
  patterns.ts …   ← 应用私有，壳不知道
  life.css
  specs/ tests/
```

`app.ts` 仍是**纯数据**（只 `import type`）：产包器要把它的值序列化成包根的 `manifest.json`，
主进程要按它做能力校验和目录布局，清单里一旦 import 组件，这两条都会把渲染侧代码拖进来。

组件不再由壳按目录约定解析——**包自己引自己那份**：`main.tsx` 把 `app.ts` 与组件一起交给 SDK 宿主。
于是"壳怎么知道这个应用存在"与"壳怎么拿到它的界面"彻底分开了：前者是运行期扫包（§7.3），
后者根本不存在了——壳加载的是 `airship://<id>/index.html`，界面从包里长出来。

### 7.2 AppManifest

```ts
// src/shared/app.ts —— 纯数据，主进程与渲染进程共用
export interface AppMeta {
  id: string                    // 唯一，必须等于目录名；同时是数据目录名
  name: string                  // 界面显示名
  description: string           // 一句话
  capabilities: Capability[]    // 声明式权限
  sharedNamespaces?: SharedNamespace[]
  flush?: boolean               // 内容区是否去掉壳给的内边距
  defaultWidth?: number         // 窗口宽高：不写用壳的默认 1100×740
  defaultHeight?: number        // 两维各自独立可缺；壳不记窗口状态，改这两个数立刻生效
  tools?: ToolName[]            // 要用的外部工具；名字来自壳的工具表
  platforms?: PlatformId[]      // 只在这些平台可用；不写 = 全平台可用
}
```

清单里**没有**图标字段，也**没有**顺序字段：

- 图标是**文件约定**：往 `apps/<id>/` 扔一张 `icon.svg`（也接受 png / jpg / jpeg / webp），
  有且只能有一张，缺了或多张都在产包期直接报错。壳不解析它的内部结构，
  也不规定它是几条 path、有没有 circle/渐变、甚至是不是位图。
  清单里写 `iconPath: string` 那种做法等于假定"图标必须是单条 path 的 SVG"，两个假定都错。
  图标单独成文件而不是从组件模块里引，是因为启动器要给每个应用画图标：
  走模块图就得把应用本体（pdf 那 800KB）拉进启动器，格子第一屏就慢了。
  现在它是包根那一张文件，启动器经 `airship://<id>/icon.*` 直接读。
  代价：文件图标拿不到 `currentColor`，颜色得烘进图里。小于 4KB 的 SVG 会被 Vite 内联成 `data:` URL（CSP 的 `img-src` 已允许），
  大图则作为文件走 `'self'`。
- 顺序是应用之间的**关系**，任何单个应用都不可能"自己决定"自己的排位。
  壳按名字典序排（`localeCompare(…, 'zh')`）。

与上面两条相反，`tools` 与 `platforms` 是**应用自己的事实**，所以它们进清单：
依赖 `wslc.exe` 的东西在别的平台上根本跑不起来（`platforms: ['windows']` → 非 Windows 不进格子、硬开被拒），
要用外部工具就得说清是哪一个（`tools: ['wslc']` → 壳才给路径，也才可审计"谁能跑子进程、跑的是什么"）。
两个字段的合法值都由壳定义（`TOOL_NAMES` / `PLATFORM_IDS`），清单里写了不认识的名字在产包期直接报错。

组件入口不在清单里，由包自持：`apps/<id>/main.tsx` 把 `app.ts` 那份清单与
`ComponentType<{ api: AppApi }>` 一起交给 `createAirshipApp`。清单里不写组件路径——
写与不写都是同一份约定，而约定只有一处（`code/build-apps.mjs` 认这四份文件）。

展示信息（图标、强调色、说明）属于 manifest：它们是"这个应用是什么"的一部分，壳统一排版等于壳替应用做决定。壳只提供 CSS 变量与控件类，应用可覆盖自己区域内的样式。

### 7.3 发现与注册 `[已实现]`

**名单只有一份，住在主进程，来自运行期扫包。**

```
包根（顺序就是优先级，先扫到的占住这个 id）。每个包是一个 zip 归档 `<id>.airship`：
  1 开发/测试根   AIRSHIP_APPS_ROOT → dist-apps/<id>.airship   （发布版忽略这个变量）
  2 自装根        %LOCALAPPDATA%\airship\apps\<id>.airship      （非 Windows 退回 userData 旁边）

没有第三个"出厂根"：安装包是纯壳，一个应用都不带（2026-11-07 定）。分发单位只有 airship 包，
装它的入口只有启动器上的拖放。`just build` 两条都跑，但产物互不包含。```

- `services/packageRoots.ts`：把这三处算成一张有序表。不 import electron——判定条件当参数收进来，
  所以"发布版忽略 env"这种规矩测得了。
- `services/packageRegistry.ts`：扫一级文件名以 `.airship` 结尾的归档，从归档里读 `manifest.json`，
  过 `@airship/contract` 的两份判据，收下合格的、记下不合格的原因。
  **坏包不占名**：不合格的那一份连 id 都拿不到，压不住同 id 能用的那一份。
- `services/packageArchive.ts`：读归档。用 fflate 的 `unzipSync(data, { filter })`——
  列条目名时 filter 返回 false（一个字节都不解压），取文件时只解那一条。不整包展开。
- `services/appRegistry.ts`：对外函数名与拆包前那份 glob 注册表一一对得上（`appIds` / `capabilitiesOf` /
  `canAccessShared` / `appsAvailableOn`…），所以 `ipc.ts`、`grants`、`paths.ts`、`windows.ts` 没跟着改。
  **能力边界不在这次改动里。**
- 渲染侧不再扫任何东西：启动器问 `airshipShell.apps()` 拿名单（`InstalledApp` = 清单 + 图标地址 +
  来自哪一档根），应用窗口连名单都不需要——它的清单在自己包里。

壳从清单派生：应用列表、能力校验、数据目录、窗口尺寸与标题；显示顺序由壳按名字典序定。
清单 id 与目录名不一致、id 重复、缺图标或多张图标、缺入口文档、`schemaVersion` 对不上——
都不进注册表，并且每条原因落一行日志（`这个包没装进来`）。一个都没扫到时日志喊
`一个应用都没装进来` 并把找过的包根列出来，界面上那句提示见 SH-020。

**加一个应用 = 新建 `apps/<id>/` 写四份文件（`app.ts` / `index.html` / `main.tsx` / 一张 `icon.*`），
`just build-apps` 产包，壳侧零改动。**（不变量 I-5，AP-010 与 AP-001 守着）

装包只有一条入口：把归档拖到启动器上（PK-015~020）。主进程侧是
`services/packageInstall.ts` —— 复用 validateArchive 同一份判据、写暂存名再改名、失败把旧包挪回来；落点固定是自装根。同 id 已在自装根里时必须确认才换（覆盖是唯一不可逆的动作：下次打开跑的是新代码，而 `%APPDATA%/airship/apps/<id>/` 那份数据会被新代码接着读）。装完不自动开窗口——装与跑是两件事。

卸载是同一条链的反向，入口也只有启动器那一扇（顶栏那颗管理键，PK-021~025 / SH-025~029）。四件实现上的理由：
**只收 id**——归档的绝对路径留在主进程，与装包"路径不出去"同一条；**删的是注册表里生效那一份**——两档根同 id
时（§7.3 的遮蔽）被遮住的那一份卸不到，卸掉生效那份它随之顶上，所以回执里带 `tookOverByOtherRoot`，界面上必须念；
**窗口开着就不动磁盘**——归档正被 `airship://` 供着，删掉那个窗口就活在后续请求全 404 的半死状态，而壳替人关窗口
会抹掉正在编辑的东西，所以拒掉、让人自己关（`ipc.ts` 问窗口台账算出那一个布尔，服务层不 import 窗口那一族）；
**数据这一族由人当场选**——装包那张卡片承诺过"数据目录不会动"，卸载是唯一动它的地方。删归档走三轮重试
（Windows 上正被读的短暂占用），缓存 `forgetArchive` + 重扫，顺手 `grants.forget(id)`：授权记的是 id，
而 id 认不出"重装回来的还是不是同一只手写的包"。`paths.ts` 因此多导出一个不建目录的 `appBaseDir(id)`——
用 `appDataDir` 去问"有没有数据"会顺手把 data 与 cache 造出来，界面上那句就念错了。

拆掉的旧机制：渲染侧 `apps/index.ts` 那份 glob（清单 + 图标 + 组件三遍 glob）与主进程那份 glob 清单。
两侧曾经各扫一遍、靠用例 `AP-008` 钉"集合一致"——现在只剩一份真源，`AP-008` 改成钉
"注册表 = 包根目录 = 仓库清单"三处一致（同一批判据，对象变了）。

### 7.4 生命周期

| 阶段 | 行为 |
|---|---|
| 启动 | 扫两个包根（开发根、自装根）→ 合格的进注册表、不合格的一条原因一行日志 → 挂 `airship://` 处理器 |
| 注册 | 清单进注册表，建该应用的数据目录，登记能力（能力表来自包清单，不来自渲染侧） |
| 打开 | 建窗口（尺寸按清单）→ 注入 `--airship-app=<id>` 的 preload → 加载 `airship://<id>/<entry>` → 包里的 `main.tsx` 调 `createAirshipApp` 装出宿主与界面 |
| 运行 | 应用自持状态；壳不介入业务，只按能力表应答桥调用 |
| 关闭 | 销毁窗口与进程 → 杀该应用的子进程 → 清它占的托盘 |

清单里没有 `onOpen/onClose` 钩子：组件的挂载/卸载已经承担了这个职责，再加一层是多余的间接。真出现"挂载前必须做完的壳级动作"再引入。

截图工装等的"就绪"信号来自 SDK 宿主（`useReportShotReady`，画完下一帧才报）——
等"脚本加载完"会截出一张占位，看着像跑起来了其实什么都没验。

### 7.5 现有八个应用

| id | 名称 | 能力 | 共享命名空间 | 工具 | 平台 |
|---|---|---|---|---|---|
| `vcp` | vcp | fs.read fs.write dialog settings proc notify clipboard log | — | ffmpeg | 全平台 |
| `books` | 墨读 | fs.read fs.write dialog settings shared notify clipboard log | library | — | 全平台 |
| `pdf` | PDF | fs.read fs.write dialog settings shared notify clipboard log | library | — | 全平台 |
| `dagogo` | 打勾勾 | fs.read fs.write dialog settings tray notify log | — | — | 全平台 |
| `life` | 生命游戏 | **一件都不声明** | — | — | 全平台 |
| `albedo` | Albedo | settings dialog fs.read fs.write clipboard | — | — | 全平台 |
| `s3` | S3 | **net** settings dialog fs.read fs.write clipboard | — | — | 全平台 |
| `wsld` | 容器台 | fs.read fs.write dialog settings proc notify clipboard log | — | wslc | **仅 windows** |

墨读与 PDF 是两个入口、一份书库：书架、导入、封面、进度是同一套数据，各存一份会出现"同一本书在两个入口各一本"。
`wsld` 是 `wslc.exe` 的图形外壳，离开 Windows 就没有那枚 CLI，所以清单写 `platforms: ['windows']`：
非 Windows 上它不进启动器格子，硬开被拒（`src/apps/specs/app-model.md` AP-006）。

---

## 8. 共享包

共享包 = 像外部依赖一样独立演化的库。在本仓库里它比 npm 依赖多一个优势：**消费者是声明出来的**（manifest 的 `sharedNamespaces`），机器可查，不用扫 lockfile 或靠记忆。

### 8.1 规则

1. **单一入口**：`shared/<name>/index.ts` 导出全部公开 API；外部只 import 目录。
2. **契约带版本**：公开 API 有 `*_API_VERSION`；持久数据结构自带 `version`（`library.json` 现在是 `version: 2`）。破坏性变更必须升版本，并在同一提交里更新所有声明了该命名空间的应用。
3. **无消费者专有概念**：共享记录里出现"某个应用才有的字段/分支"就是越界。
4. **单消费者代码留在应用里**：只有一个使用者的东西不是共享库。

### 8.2 现有共享包

| 包 | 公开内容 | 消费者 | 数据 |
|---|---|---|---|
| `library` | 书目记录、导入/移除、进度读写、封面路径解析 | books、pdf | `shared/library/` |
| `textdecode` | `decodeText`：BOM → UTF-8 严格 → GBK 回退 | vcp（srt/ass 字幕）——墨读退出 TXT 后没有别的使用者 | 无 |

`textdecode` 上收共享层的原因就是 §8.1 规则 4 的反面：墨读解正文和 vcp 解字幕遇到的是同一套坑（GBK、UTF-16 BOM），留在任何一个应用里都会逼另一个复制一份。
顺带修掉了 RN 原版的一个真缺陷——UTF-16 排在最后兜底，而 UTF-16 的中文字节能被 UTF-8 严格解"成功"，于是解出乱码永远轮不到 UTF-16；现在 BOM 先判。

`[已实现]` 三条违规已整改：包改成单一入口 `shared/library/index.ts`（外部只 import 目录，测试挡住绕过）；`BookRecord.pages` 换成通用 `meta: BookMeta`（键名由各应用自己维护，包只保证存得下读得出）；`remoteFile`、`txtBook` 搬回 `apps/books/`（只有一个消费者）。

结构变更不做静默迁移：`library.json` 的数据版本升到 v2，版本不符直接报错并说明删索引重导。迁移代码是长期负债，自用阶段不背。

---

## 9. 数据与存储

**代码根与数据根是分开的两类东西**，各管各的寿命：

```
代码根（airship 包 = zip 归档，见 §7.3）
  %LOCALAPPDATA%\airship\apps\<id>.airship      自装：拖进启动器装的那些；卸载壳不碰它，将来商店也装这儿
  dist-apps\<id>.airship                          开发：just build-apps 的落点，只被开发根扫到

数据根
%APPDATA%/airship/                    Electron userData
├── settings.json                     壳级：主题、工具路径（toolPath:<name>）——不存窗口状态
├── logs/airship-YYYY-MM-DD.log       按天；"这个包没装进来"的每一条原因在这里
├── shared/library/                   壳托管共享区
│   ├── library.json                  { version: 1, books: [...] }
│   ├── files/<id>.<ext>              书本体（导入时拷入，不依赖原路径）
│   └── covers/<id>.<ext>             封面
└── apps/<id>/
    ├── settings.json                 应用私有设置
    ├── data/                         应用私有数据
    └── cache/                        可整体删除重建
```

自装根选 `%LOCALAPPDATA%` 而不是 `%APPDATA%`：企业环境会漫游 AppData，几百 MB 的包跟着漫游是灾难；
而且 `%APPDATA%\airship` 在这台机器上是"用户数据"的语义，备份它的人不该顺带把可执行代码备份走。
外部工具发现早就同时探这两处（`services/tools.ts`），这条不算新规矩。

| 规则 | 说明 |
|---|---|
| 落盘 | 临时文件 + `rename`，中途崩溃不损坏原文件 |
| 装包 | 先写 `<id>.airship.tmp-…` 再 `rename` 成正式名；Windows 上刚写下的文件常被短暂占用，改名带三轮重试，试满还是不成就照原样抛（不留"看着装上了"） |
| 坏设置 | 解析失败则改名 `.bad`、记日志、从空开始，不致命 |
| 设置模型 | 扁平字符串键 + 可 JSON 序列化值；每应用一个文件，互不可见 |
| 写并发 | 串行队列（内存缓存 + 队列化写盘），连续操作后一次不覆盖前一次 |
| 日志 | `时间 级别 [来源] 消息 [详情单行化]`，详情截 4000 字；写日志失败不抛 |
| 清理 | 删 `apps/<id>/` 即彻底清掉该应用的数据；**删包不删数据**（包目录删掉，`apps/<id>/` 留着，装回来接得上）；删 `shared/library/` 清掉书库 |
| 名单 | 磁盘上的归档文件就是名单，没有 `installed.json` 那种账本——卸载等于删文件 |

---

## 10. 界面架构

| 部分 | 归属 | 规则 |
|---|---|---|
| 标题栏 | SDK 宿主（`src/sdk`），随包走 | 无边框窗口自绘；整条可拖拽，按钮区显式排除。应用名来自包清单，中段来自 `api.window.setTitle` |
| 应用列表 | 壳 | 从运行期扫包得到（`airshipShell.apps()`）；选中态只表示"此刻真的在这个应用里" |
| 主题 | 壳定档，SDK 落地 | 跟随系统/亮/暗三档，CSS 变量下发，全局记忆；每个包的文档里由宿主调 `useTheme` 落 `data-theme` |
| 内容区 | 应用 | 宿主按清单给内边距与滚动，`flush` 的应用自己排版 |
| 控件 | SDK 提供、应用可用可不用 | `src/sdk/styles/airship.css` 里那份基线与通用控件类，构建时打进每个包 |

`src/sdk/styles/airship.css` 是**公开面**：类名（`.app-window__body--flush`、`.btn`、`.card`、`.titlebar__*`…）
一旦被应用依赖就不能随手改。本轮 SDK 与壳同仓同版本、六个包一起重编，所以改得起；
真要独立发布，这份样式表的名字与类要跟着版本协商一起定（TD-013）。

表单两条硬规则：标签在控件左边同一行；同组字段共用一个星号列，不写死宽度。

主题传播 `[已实现]`：应用窗口只读 `airship.theme()` 并订阅 `theme:changed`；改主题只有启动器能做（`airshipShell.setTheme`），主进程落盘后广播到所有窗口。"跟随系统"的实际亮暗由启动器用 `matchMedia` 算好传给壳——主进程没有 `matchMedia`，不该猜。
每个窗口自己必须有人调 `useTheme` 把 `data-theme` 落到文档上，否则整窗 CSS 变量为空（这条是踩过才知道的：拆窗口的第一版应用窗口就没主题）。现在这一调用固定在 SDK 宿主里，包不需要记得做。

---

## 11. 错误处理与可观测性

| 层 | 策略 |
|---|---|
| 主进程 | `uncaughtException` / `unhandledRejection` 记日志不退出；IPC handler 统一包错成中文可读原因 |
| 桥 | 信封拆包，失败抛 `Error`，不吞 |
| 壳 | 能力越权、路径越界、未声明命名空间 → 抛错并记 `warn`，界面显示原因 |
| 应用 | 自行决定；契约错误一律可见的中文句子，不做静默兜底 |
| 渲染侧异常 | 主进程转发带 `[airship-dbg]` 前缀的 console，只进日志不刷屏 |

诊断入口 `[部分实现]`：启动器右上角那颗设置键进的一屏只有两行——壳版本（`app.getVersion()`，与安装包文件名同源）
与包根表（`应用安装目录`总有一行，`开发包根`只在这一档真存在时多一行；措辞取自 `PACKAGE_ROOT_LABEL`，日志里"来自哪个根"那句用它）。
契约见 SH-022 ~ SH-024。ffmpeg 可用状态、各应用当前授权路径数、每窗口内存有 IPC 可查
（`launcher:toolPath` / `launcher:grants` / `launcher:metrics`）但尚未上界面。

---

## 12. 构建与运行

| 项 | 值 |
|---|---|
| 工具链 | electron 45.2.3 · electron-vite 6.0.0 · vite 8.3.5 · react 19.3.1 · TypeScript 5.9.3 · vitest 4.1.12 |
| 关键库 | foliate-js 1.0.1（自带 mobi.js，MOBI6+KF8+PalmDOC+HUFF/CDIC）· pdfjs-dist 6.5.438 |
| 版本约束原因 | vitest 5 要求 node ≥26，本机 node 25.9，故钉 4.x；npm registry 与 electron 二进制走 npmmirror |
| 构建 | 两条独立的链。**壳**：`just compile` = `electron-vite build src/shell` → `src/shell/out/{main,preload,renderer}`（renderer 只剩启动器一份 html）。**应用**：`just build-apps` → `code/build-apps.mjs` 逐应用跑一次 vite 构建（`root` 就是那个应用目录、`base: './'`），再用 `code/pack-app.mjs` 打成 `dist-apps/<id>.airship`（zip 归档，条目名就是包内路径） |
| 谁钉住 Electron 版本 | 壳的 `package.json` 写**固定值** `45.2.3`（不带 `^`）：electron-builder 按它下载对应平台的二进制，写范围会被直接拒 |
| 版本号 | 安装包文件名与 exe 的文件版本都取自 `src/shell/package.json`；包清单里的 `sdkVersion` 取自 `src/sdk/package.json` |
| 为什么每应用各构建一次 | 一次构建里放六份 html，Rollup 会把 React 抽成一份共享 chunk，六个包就互相依赖了——那正是这次要拆掉的东西。分开构建才是"一个包自带全部东西" |
| 两份 React 的坑 | workspace 软链进 `node_modules` 后，rollup 的 commonjs 互操作会把 `react` 各包一遍，现象是 `useState` 读到 `null`。三份构建配置与 vitest 都写了 `resolve.dedupe: ['react','react-dom','react/jsx-runtime']`，别摘 |
| 打包 | `just build` = `build-apps` + `build-shell`；后者是清场 → 编译壳 → `electron-builder --projectDir src/shell`（NSIS，**纯壳：不带任何 airship 包**）→ 自检并写 `.sha256`；细节见 [release-packaging.md](release-packaging.md)，还没做的那几件在 [todo.md](todo.md) |
| 体积实测 | 拆包**不减安装包体积**：`app.asar` 从 3.4 MB 降到壳自己的约 0.7 MB，六个归档合计约 1.2 MB（zip 压过，实测 life 240 KB → 79 KB）；安装包 122.2 MB → 122.6 MB。换来的是"改一个应用只重出一个包"与"应用能独立分发"，不是体积 |
| 图标 | 母版 `src/shell/assets/icon-master.png`（用户提供的图形），`python code/make-icons.py` 重出 `src/shell/assets/icon.png`（256，窗口图标）与 `src/shell/assets/tray.png`（16，托盘默认），`python code/make-ico.py` 重出 `src/shell/assets/icon.ico`（16–256 七档，安装包与 exe 的图标）；标题栏那颗品牌图形在 `src/sdk/Titlebar.tsx`，应用自己的图标由 `main.tsx` 的 `icon` 参数交给宿主 |
| 数据目录名 | 主进程开头 `app.setName('airship')` 钉死：Electron 的 userData 默认取 package.json 的 name，而壳的 name 是 `@airship/shell`——不钉住，`%APPDATA%/airship` 里的书架与设置看着像"凭空消失"了 |
| 安全 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；`webSecurity` 默认 `true`，**只有清单声明了 `net` 的那个应用窗口**关掉它（同源策略与混合内容一起豁免，见 BR-011）；CSP 由 `src/sdk/csp.ts` 一份、构建时注入每个包的入口 html（AP-014），按清单选档：默认那条 `connect-src` 收紧，声明了 `net` 的那一档放到 `http:` 与 `https:`（AP-017），两档的 `script-src` 都只 `'self'`；允许 `blob:`（foliate 用 blob iframe 与 blob 样式表）与样式 `unsafe-inline`；`airship://` 处理器只读、只到自己那一个包目录（PK-014） |
| 外部链接 | 只放行 `http/https`，交给系统浏览器；`file://` 与自定义协议不开新窗 |

命令：`just new-app` 造应用 · `just build-apps` 产包 · `just compile` 编译壳 · `just build-shell` 出安装包 · `just build` 两条一起跑 · `just dev` 开发（先 build-apps） · `just verify-installer` 出包自检 · `just test` 单测 · `just casecov` 册子与用例的双向差集 · `just typecheck` 两个 tsconfig · `just shot` 逐窗口截图（先 compile + build-apps） · `just e2e` 真编码用例 · `just wsld-real` 真 `wslc` 只读命令。

---

## 13. 规格册与验证架构

判据是"看到可观察结果"，不接受"构建成功=能用"。

**册子是契约，用例是它的影子。** 全库 21 本册子（壳 8 本 + 应用区 2 本：`app-model` 与 `package` + 共享包 2 本 + 六个应用 9 本），
四档结构（Purpose / Requirement / Scenario / WHEN-THEN-AND）、稳定编号、只写可观察结果、不写实现。
规矩与能力索引见 [specs/index.md](specs/index.md)。

绑定方式：用例标题以编号开头（`it('SH-001 …')`），`just casecov` 做**双向差集**——
册里有号没用例 = 未实现，用例有号册里没有 = 私测。两者都算红。
"写不出可执行判据"的期望不进册子（单实例锁、崩溃隔离这类留在本文 §3）。

| 层 | 手段 | 覆盖什么 |
|---|---|---|
| 契约册 | `docs/specs/*.md` + `tests/spec-coverage.test.ts` | 用户可见的结果有清单、有影子、没私测 |
| 类型 | 两个 tsconfig 分别 `tsc --noEmit` | 契约与实现签名一致 |
| 逻辑单测 | vitest（node 环境）：纯逻辑层 + 主进程服务（`electron` 换替身，磁盘用临时目录） | 业务规则与壳的判定不回归 |
| 界面用例 | jsdom + `tests/helpers/mount.tsx` + `tests/helpers/fakeAirship.ts`（壳的测试替身） | 真渲染真点击：看得见什么文字、点下去变成什么、被拒时念哪句 |
| 边界测试 | 扫 import 图 | 不变量 I-1、I-5、I-6 |
| 门控用例 | `VCP_E2E=1` 真编码；`AIRSHIP_WSLD_INTEGRATION=1` 真 `wslc` 只读命令 | 与真实外部 CLI 的集成；默认跳过，编号仍算已实现 |
| 渲染 | `just shot` 逐窗口 `capturePage`，真书/真 PDF/真视频探测数据 | 真的画出来了 |
| 性能 | 按用户可感知口径实测：窗口挂载、开书、PDF 出图、每窗口内存 | 不是猜的（§3.1） |

`tests/helpers/fakeAirship.ts` 是这一层的地基：它按契约把 `window.airship` 装成一个内存里的小壳——
能力闸门与拒绝措辞直接取 `shared/errors.ts` 那份真句子，路径授权、共享命名空间、proc 白名单与流式事件都照壳的规矩走。
所以"应用没声明某能力时用户看到的那句中文"在测试里就是真实界面里的那句，而不是测试自己编的。

当前规模与核对：见本文末尾的验证记录。

---

## 14. 已定与未尽

**已定（原待定项）**

- 共享记录的附加信息用通用 `meta` 键值，不给单个格式开专属字段。
- 应用与壳**不同构建**（2026-11-07 落地）：壳的产物里只有壳与 SDK，六个应用各自是一个 `dist-apps/<id>.airship/` 包，
  运行期被扫出来。旧的"每应用一个 chunk + 一份公共 chunk（React 等）"随构建期 glob 一起退场——
  现在每应用各构建一次，React 各带一份，代价是包总量微升、换来的是改一个应用只重出一个包（§12）。
  实测空闲窗口 87–104 MB（拆包前后同一档），见 §3.1。
- 一个 id 只有一份活动包，版本写进 `manifest.json` 不写进目录名：数据目录按 id 分（`apps/<id>/data`），
  两版并存就是共享同一个数据目录而没人仲裁 schema。要并存得是一次显式契约变更。
- 包的文档面是 `airship://<id>/<相对路径>`，可达范围钉死在那一个包目录（PK-014）。

**未尽**

全部移到 [待办清单](todo.md)（TD-001 到 TD-014），这本里不再抄一份。
其中与架构直接相关的三条：TD-001 任务栏身份还没真做到一应用一个、
TD-009 拉取实时进度是 `proc` 缺伪终端造成的**能力缺口**而不是省事、
TD-013 SDK 独立发布与版本协商（拆包留下的最贵的一条：包按某个 SDK 版本构建、跑在用户机器上任意一个壳版本里）。

---

## 15. 术语

| 术语 | 含义 |
|---|---|
| 契约 bridge | `protocol.ts` 声明的、应用可用的全部能力 |
| 能力 capability | 应用主动声明的权限位 |
| 授权 grant | 用户经对话框显式给某应用的路径读取/写入许可，进程生命周期内有效 |
| 命名空间 namespace | 壳托管的共享数据区，应用声明才可见 |
| 共享包 shared package | 有单一入口与版本、像外部依赖一样演化的多应用共用库 |
| 清单 manifest | `apps/<id>/app.ts` 导出的 AppManifest，一个应用对外形状的全部 |
| 设计边界 vs 强制边界 | 前者靠纪律（同进程），后者靠进程隔离；本架构的目标是后者 |
