# airship 架构

飞船是一个 Electron 桌面壳，把自用的多个应用装进同一个安装体里运行。本文描述**这个软件的架构**——组成、边界、规则与不变量；不描述某一轮施工计划。

代码：`Develop/airship`

状态标记：`[已实现]` 架构规定且代码已达到 · `[待达]` 架构已规定，实现尚未达到

当前进度（2026-11-06）：**§3 每应用独立窗口已落实**，能力边界是强制而非约定（身份由 preload 注入 + 主进程按 `event.sender` 反查归属，双重确认），七条不变量全部有测试或机制守住。
用户可见契约已按册子建档（册子与用例跟着代码放在各自区域，索引在 `docs/specs/index.md`），用例编号与册子双向差集由 `just casecov` 钉住。
本轮契约变化：拒绝措辞收进 `shared/errors.ts` 一份；清单新增 `platforms`（平台可用）与 `tools`（外部工具声明）；`tools.ffmpegPath()` 改为 `tools.path(name)`，工具发现做成内置表（ffmpeg / wslc）。实测数据见 §3.1。

---

## 1. 系统组成

```
airship
├── 壳 src/shell/
│   ├── main/          主进程：窗口管理、IPC、能力实现（存储/授权/子进程/托盘/工具发现）
│   ├── preload/       桥：按契约白名单暴露 window.airship 与 window.airshipShell
│   └── *.tsx / *.html 壳界面：启动器（应用列表）、单应用宿主、标题栏、主题、测试钩子
├── 应用 src/apps/<id>/    每个应用由一份清单完整定义
└── 共享 src/shared/
    ├── protocol.ts / app.ts   契约：类型、能力、事件（依赖图最下层）
    ├── errors.ts              拒绝原因措辞的唯一真源（主进程、启动器、测试替身共用）
    ├── registryRules.ts       应用注册的校验规矩（主进程与渲染侧共用一份）
    └── <name>/                共享包：library、textdecode（各自单一入口）
```

三者关系一句话：**应用声明能力 → 壳按声明放行 → 共享包只通过入口暴露契约 → 数据由壳托管**。

目录按**角色**而不是按 Electron 的执行上下文切。理由：读代码的人关心的是"这是壳、这是应用、这是共享"，而架构规则也是按角色表述的；上下文（main / preload / renderer）只在 `shell/` 内部再分，因为**特权代码只存在于壳里**——`apps/**` 和 `shared/**` 按契约全是渲染侧代码，这条不变量比按上下文切目录更强、也更好审计。

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
├── 启动器窗口 (1)      壳自己的 UI：应用列表、诊断、设置
└── 应用窗口 (0..N)     每应用一个；关闭即销毁其进程
```

| 方面 | 规定 | 状态 |
|---|---|---|
| 打开方式 | 点应用 → 新窗口；已开则聚焦，不重复开 | `[已实现]` |
| 平台可用 | 清单 `platforms` 不写 = 全平台可见；写了就只在列出的平台进格子，硬开被拒并说清原因 | `[已实现]` |
| 关窗收尾 | 应用窗口关闭 → 销毁进程 + 杀掉该应用名下的子进程 + 清它占的托盘 | `[已实现]` |
| 渲染进程 | 每窗口独立，`sandbox: true` | `[已实现]` |
| 崩溃隔离 | 一个应用崩溃只影响自己 | `[已实现]` |
| 任务栏 | 每应用独立 `setAppUserModelId`，可独立固定与预览 | `[已实现]`（Windows 专有方法，非 Windows 平台静默跳过） |
| 事件路由 | 壳事件只投递给归属窗口；应用收不到别的应用的 `proc` 事件 | `[已实现]`，`tests/isolation.test.ts` 守住 |
| 身份注入 | 应用侧不传 id：preload 按启动参数绑定，主进程按 `event.sender` 反查二次确认 | `[已实现]` |
| 单实例 | 二次启动唤起已有启动器 | `[已实现]` |
| 窗口状态 | **不记**：宽高每次按清单 `defaultWidth/defaultHeight`（SH-015/016），位置每次由系统摆（SH-018）——换块屏幕不会把窗口丢到屏外 | `[已实现]` |
| 退出 | 关所有窗口 → 杀干净子进程 → 清托盘 | `[已实现]` |

### 3.1 实测数据

截图模式顺带采样（`[metrics]` / `[perf]` 两行），耗时都按"从该应用窗口打开算起"。

| 窗口 | 内存（空闲） | 内存（开着内容） |
|---|---|---|
| 启动器 | 86.7–87.2 MB | — |
| vcp | 96.9–100.8 MB | — |
| 墨读 | 105.3 MB | 163.9 MB（《第一推动》15 册套装） |
| PDF | 101.3–103.9 MB | 318.5 MB（2 页执照，125% 缩放） |
| 打勾勾 | 97.8–101.1 MB | — |

| 可感知耗时 | 数字 |
|---|---|
| 应用窗口挂载（冷） | 400–420 ms |
| 应用窗口挂载（热） | 120–160 ms |
| EPUB 打开到首屏渲染完 | 598–741 ms |
| TXT 打开到首屏渲染完 | 180 ms（热） |
| PDF 首页出图 | 893 ms |
| vcp 探测一个 4K 文件 | 523 ms |
| vcp 批量入队 4 个（含逐个探测与字幕抽取） | 486 ms |

结论：每个渲染进程约 90–105 MB 是窗口化的真实代价，四个应用全开约 400 MB。
架构接受这个代价换隔离；PDF 是内存大头（pdf.js 位图 + 画布），不是壳的开销。

---

## 4. 分层与依赖方向

```
src/
  shared/
    protocol.ts        契约：能力、事件、AppApi、启动器面        ← 依赖图叶子
    app.ts             AppMeta（清单类型，纯数据）              ← 依赖图叶子
    errors.ts          拒绝原因的措辞        → 只依赖 protocol / app
    registryRules.ts   注册校验规矩          → 只依赖 protocol / app / errors
    library/index.ts   共享包：书库        → 只依赖 protocol
    textdecode/index.ts 共享包：中文解码    → 无依赖
  shell/
    main/              主进程：index windows ipc services/*
    preload/           桥：身份注入、两套面、事件单频道
    *.tsx *.ts *.html  启动器与单应用宿主、标题栏、主题、测试钩子、样式
  apps/
    index.ts           注册表：glob 收集清单与组件
    vcp/ books/ pdf/ dagogo/
```

别名（`electron.vite.config.ts` 与两个 tsconfig 同步定义）：
`@shared/*` → `src/shared/*`，`@apps/*` → `src/apps/*`，`@shell/*` → `src/shell/*`。

允许（单向）：

```
apps          ──→ shared          ──→ protocol / app
apps          ──→ shell（渲染侧库：theme / shot / autotest / api）
shell         ──→ apps（只走注册表 apps/index.ts，不摸应用内部模块）
shell/main    ──→ apps/<id>/app.ts（纯数据清单；两侧同一个真源）
shell/main · shell/preload ──→ shared
```

主进程读清单是**必要的**：能力校验必须在主进程做，若由渲染侧把能力传过来，等于没有校验。
清单被设计成纯数据（不 import 组件），所以这条边不会把渲染侧代码拖进主进程构建。

禁止：`apps ↔ apps`、`shared → apps`、`shared → shell`、应用绕过共享包入口 import 其内部文件、
壳 import `apps/<id>/…`（只能走注册表）。

`shared/protocol.ts` 与 `shared/app.ts` 是依赖图的叶子：只定义类型与常量，不 import 任何东西，
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

### 6.1 能力位（10 项）

`fs.read` `fs.write` `dialog` `settings` `shared` `proc` `tray` `notify` `clipboard` `log`

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
apps/vcp/
  app.ts          ← 纯数据清单：这个应用对外形状的全部
  icon.svg        ← 图标文件（png/jpg/jpeg/webp 也行，只能有一张）
  index.tsx       ← 组件入口（默认导出），壳按目录约定解析
  VcpApp.tsx      ← 组件本体
  state.ts command.ts probe.ts jobs.ts runner.ts   ← 应用私有，壳不知道
  vcp.css
  tests/
```

清单**不含组件引用**，是刻意的：主进程也要读同一批 `app.ts` 做能力校验和目录布局，
清单里一旦 import 组件，主进程就会把渲染侧代码拖进构建。组件由目录约定（`index.tsx`）解析，
应用不用在清单里写路径。

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
  有且只能有一张，缺了或多张都在注册期直接报错。壳不解析它的内部结构，
  也不规定它是几条 path、有没有 circle/渐变、甚至是不是位图。
  清单里写 `iconPath: string` 那种做法等于假定"图标必须是单条 path 的 SVG"，两个假定都错。
  图标单独成文件而不是跟组件同处 `index.tsx`，是因为启动器要给四个应用画图标，
  同 chunk 就得把 pdf 那 800KB 一起拉进来，懒加载白做。
  代价：文件图标拿不到 `currentColor`，颜色得烘进图里。小于 4KB 的 SVG 会被 Vite 内联成 `data:` URL（CSP 的 `img-src` 已允许），
  大图则作为文件走 `'self'`。
- 顺序是应用之间的**关系**，任何单个应用都不可能"自己决定"自己的排位。
  壳按名字典序排（`localeCompare(…, 'zh')`）。

与上面两条相反，`tools` 与 `platforms` 是**应用自己的事实**，所以它们进清单：
依赖 `wslc.exe` 的东西在别的平台上根本跑不起来（`platforms: ['windows']` → 非 Windows 不进格子、硬开被拒），
要用外部工具就得说清是哪一个（`tools: ['wslc']` → 壳才给路径，也才可审计"谁能跑子进程、跑的是什么"）。
两个字段的合法值都由壳定义（`TOOL_NAMES` / `PLATFORM_IDS`），清单里写了不认识的名字在注册期直接报错。

组件入口不在清单里，由约定解析：`apps/<id>/index.tsx` 默认导出 `ComponentType<{ api: AppApi }>`。

展示信息（图标、强调色、说明）属于 manifest：它们是"这个应用是什么"的一部分，壳统一排版等于壳替应用做决定。壳只提供 CSS 变量与控件类，应用可覆盖自己区域内的样式。

### 7.3 发现与注册 `[已实现]`

两侧抓的是**同一批清单文件**，不存在两份名单对不齐：

- 渲染侧 `apps/index.ts`：三个 glob——`app.ts` 拿清单（急切）、`icon.{svg,png,jpg,jpeg,webp}` 拿图标 URL（急切，`?url`）、`index.tsx` 拿组件（懒，每应用一个 chunk）。
- 主进程 `services/appRegistry.ts`：`import.meta.glob('../../../apps/*/app.ts', { eager: true })` 派生能力表、目录布局、共享命名空间授权。

壳从清单派生：应用列表、能力校验、数据目录、懒加载入口；显示顺序由壳按名字典序定。目录名与清单 id 不一致、缺图标或多张图标、缺组件入口、id 重复——注册表构建期直接抛错，不留"注册了一半"的应用。

**加一个应用 = 新建 `apps/<id>/` 写 `app.ts`、`icon.svg`、`index.tsx` 三个文件，壳侧零改动。**（不变量 I-5；已用临时 `apps/hello/` 演练证实——只加新目录就出现在启动器并能打开，随后删除）

代价：应用 id 的类型从 `as const` 联合降级为 `string` + 运行时校验（`isKnownApp`），因为清单成了唯一真源。可接受——应用从不传自己的 id，id 由壳绑定注入。

### 7.4 生命周期

| 阶段 | 行为 |
|---|---|
| 注册 | 启动时读清单，建目录，登记能力 |
| 打开 | 懒加载组件 chunk → 建窗口 → 注入 `AppApi` → 组件挂载 |
| 运行 | 应用自持状态；壳不介入业务 |
| 关闭 | 组件卸载（清理放卸载钩子）→ 销毁窗口与进程 → 杀该应用的子进程 → 清它占的托盘 |

清单里没有 `onOpen/onClose` 钩子：组件的挂载/卸载已经承担了这个职责，再加一层是多余的间接。真出现"挂载前必须做完的壳级动作"再引入。

`[待达]` 当前实现是单窗口内常驻挂载（切走只隐藏，不卸载），目的是阅读器翻页进度、vcp 跑着的转码任务不因切换应用而丢。窗口化后这个需求由"窗口不关就不销毁"承接。

### 7.5 现有六个应用

| id | 名称 | 能力 | 共享命名空间 | 工具 | 平台 |
|---|---|---|---|---|---|
| `vcp` | vcp | fs.read fs.write dialog settings proc notify clipboard log | — | ffmpeg | 全平台 |
| `books` | 墨读 | fs.read fs.write dialog settings shared notify clipboard log | library | — | 全平台 |
| `pdf` | PDF | fs.read fs.write dialog settings shared notify clipboard log | library | — | 全平台 |
| `dagogo` | 打勾勾 | fs.read fs.write dialog settings tray notify log | — | — | 全平台 |
| `life` | 生命游戏 | **一件都不声明** | — | — | 全平台 |
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
| `textdecode` | `decodeText`：BOM → UTF-8 严格 → GBK 回退 | books（TXT 正文）、vcp（srt/ass 字幕） | 无 |

`textdecode` 上收共享层的原因就是 §8.1 规则 4 的反面：墨读解正文和 vcp 解字幕遇到的是同一套坑（GBK、UTF-16 BOM），留在任何一个应用里都会逼另一个复制一份。
顺带修掉了 RN 原版的一个真缺陷——UTF-16 排在最后兜底，而 UTF-16 的中文字节能被 UTF-8 严格解"成功"，于是解出乱码永远轮不到 UTF-16；现在 BOM 先判。

`[已实现]` 三条违规已整改：包改成单一入口 `shared/library/index.ts`（外部只 import 目录，测试挡住绕过）；`BookRecord.pages` 换成通用 `meta: BookMeta`（键名由各应用自己维护，包只保证存得下读得出）；`remoteFile`、`txtBook` 搬回 `apps/books/`（只有一个消费者）。

结构变更不做静默迁移：`library.json` 的数据版本升到 v2，版本不符直接报错并说明删索引重导。迁移代码是长期负债，自用阶段不背。

---

## 9. 数据与存储

```
%APPDATA%/airship/                    Electron userData
├── settings.json                     壳级：主题、工具路径（toolPath:<name>）——不存窗口状态
├── logs/airship-YYYY-MM-DD.log       按天
├── shared/library/                   壳托管共享区
│   ├── library.json                  { version: 1, books: [...] }
│   ├── files/<id>.<ext>              书本体（导入时拷入，不依赖原路径）
│   └── covers/<id>.<ext>             封面
└── apps/<id>/
    ├── settings.json                 应用私有设置
    ├── data/                         应用私有数据
    └── cache/                        可整体删除重建
```

| 规则 | 说明 |
|---|---|
| 落盘 | 临时文件 + `rename`，中途崩溃不损坏原文件 |
| 坏设置 | 解析失败则改名 `.bad`、记日志、从空开始，不致命 |
| 设置模型 | 扁平字符串键 + 可 JSON 序列化值；每应用一个文件，互不可见 |
| 写并发 | 串行队列（内存缓存 + 队列化写盘），连续操作后一次不覆盖前一次 |
| 日志 | `时间 级别 [来源] 消息 [详情单行化]`，详情截 4000 字；写日志失败不抛 |
| 清理 | 删 `apps/<id>/` 即彻底清掉该应用；删 `shared/library/` 清掉书库 |

---

## 10. 界面架构

| 部分 | 归属 | 规则 |
|---|---|---|
| 标题栏 | 壳 | 无边框窗口自绘；整条可拖拽，按钮区显式排除 |
| 应用列表 | 壳 | 从 manifest 生成；选中态只表示"此刻真的在这个应用里" |
| 主题 | 壳 | 跟随系统/亮/暗三档，CSS 变量下发，全局记忆 |
| 内容区 | 应用 | 壳给内边距与滚动，`flush` 应用自己排版 |
| 控件 | 壳提供、应用可用可不用 | 按钮/输入/卡片/字段网格等类与 CSS 变量 |

表单两条硬规则：标签在控件左边同一行；同组字段共用一个星号列，不写死宽度。

主题传播 `[已实现]`：应用窗口只读 `airship.theme()` 并订阅 `theme:changed`；改主题只有启动器能做（`airshipShell.setTheme`），主进程落盘后广播到所有窗口。"跟随系统"的实际亮暗由启动器用 `matchMedia` 算好传给壳——主进程没有 `matchMedia`，不该猜。
每个窗口自己必须有人调 `useTheme` 把 `data-theme` 落到文档上，否则整窗 CSS 变量为空（这条是踩过才知道的：拆窗口的第一版应用窗口就没主题）。

---

## 11. 错误处理与可观测性

| 层 | 策略 |
|---|---|
| 主进程 | `uncaughtException` / `unhandledRejection` 记日志不退出；IPC handler 统一包错成中文可读原因 |
| 桥 | 信封拆包，失败抛 `Error`，不吞 |
| 壳 | 能力越权、路径越界、未声明命名空间 → 抛错并记 `warn`，界面显示原因 |
| 应用 | 自行决定；契约错误一律可见的中文句子，不做静默兜底 |
| 渲染侧异常 | 主进程转发带 `[airship-dbg]` 前缀的 console，只进日志不刷屏 |

诊断入口 `[部分实现]`：启动器显示 ffmpeg 可用状态、数据目录、应用数与版本（已实现）；各应用当前授权路径数有 IPC 可查（`shell:grants`）但尚未上界面。

---

## 12. 构建与运行

| 项 | 值 |
|---|---|
| 工具链 | electron 45.2.3 · electron-vite 6.0.0 · vite 8.3.5 · react 19.3.1 · TypeScript 5.9.3 · vitest 4.1.12 |
| 关键库 | foliate-js 1.0.1（自带 mobi.js，MOBI6+KF8+PalmDOC+HUFF/CDIC）· pdfjs-dist 6.5.438 |
| 版本约束原因 | vitest 5 要求 node ≥26，本机 node 25.9，故钉 4.x；npm registry 与 electron 二进制走 npmmirror |
| 构建 | 三目标：main / preload / renderer；应用各自懒加载 chunk |
| 打包 | `just dist`：electron-builder 出 NSIS 安装包 `release/airship-Setup-<版本>-x64.exe`，`just verify-installer` 自检并写 `.sha256`；细节与未做的事（无代码签名、无自动更新）见 [release-packaging.md](release-packaging.md) |
| 图标 | 母版 `assets/icon-master.png`（用户提供的图形），`python code/make-icons.py` 重出 `assets/icon.png`（256，窗口图标）与 `assets/tray.png`（16，托盘默认），`python code/make-ico.py` 重出 `assets/icon.ico`（16–256 七档，安装包与 exe 的图标）；标题栏那颗品牌图形是同一张图的 SVG 简化版，写在 `shell/Titlebar.tsx` |
| 安全 | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、`webSecurity: true`；CSP 允许 `blob:`（foliate 用 blob iframe 渲章节）与样式 `unsafe-inline`（禁掉书就没排版），脚本只 `'self'` |
| 外部链接 | 只放行 `http/https`，交给系统浏览器；`file://` 与自定义协议不开新窗 |

命令：`just dev` 开发 · `just build` 构建 · `just dist` 出安装包 · `just verify-installer` 出包自检 · `just test` 单测 · `just casecov` 册子与用例的双向差集 · `just typecheck` 两个 tsconfig · `just shot` 逐窗口截图 · `just e2e` 真编码用例 · `just wsld-real` 真 `wslc` 只读命令。

---

## 13. 规格册与验证架构

判据是"看到可观察结果"，不接受"构建成功=能用"。

**册子是契约，用例是它的影子。** `docs/specs/` 一本册子管一块用户可见的东西（壳 9 本 + 共享包 2 本 + 每应用一本），
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
- 窗口化的共享依赖：构建已自然分成"每应用一个 chunk + 一个公共 chunk（React 等）"，各窗口共用公共 chunk，不需要额外处理。实测空闲窗口 90–105 MB，见 §3.1。

**未尽**

1. **MOBI 仍无真样本可验**。解析走 foliate-js 自带的 `mobi.js`，与 EPUB 同一条 `view.open` 自动识别路径；机器上没有 .mobi/.azw3，这条只能挂着。
2. **EPUB 翻页延迟未单独采样**。目前只有"打开到首屏"的数字；翻页要另做标记。
3. **阶段 D 已做，阶段 C 未做**。`just dist` 出 Windows 安装包（见 [release-packaging.md](release-packaging.md)），但应用与壳仍同仓同构建——改一个应用要重出整个安装包："独立修改"已经做到，"独立构建"（运行时从磁盘加载应用包）还没做。安装包也没有代码签名，首次运行会有 SmartScreen 那道提示。
4. **窗口数不设上限**：六个应用全开约 500 MB。真觉得吃紧再加"同应用多窗口"或闲置回收策略。
5. **wsld 只移植了核心三块**（容器、镜像、日志）。原版还有而这里先没有的：`run` 命令编排（40 余字段拼装/校验/反解）、
   registry mirror（Docker Hub 路径改写与 pull 后改名）、拉取实时进度。
   最后那个是**能力缺口**而不是省事：原版的逐层进度靠 ConPTY 伪终端把 wslc 当全屏应用来读（`VtScreenTracker` 那套屏幕模型），
   而本项目 `proc` 只有管道分块——没有 TTY 就没有那套帧。要么以后给 `proc` 加伪终端能力，要么按普通管道输出重做进度呈现。
   界面语言与主题原版的 `i18n.md` / `theme.md` 不搬：本项目只做中文，换皮归壳（`src/shell/specs/theme.md`）。

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
