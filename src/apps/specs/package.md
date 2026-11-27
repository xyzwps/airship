# package

## Purpose
一个 airship 包在磁盘上长什么样：它是一个 **zip 归档**，文件名 `<id>.airship`，里面的条目名就是包内路径。
这本册子钉包名的形状、包清单的字段、包内引用的边界、直跑注册失败时留下什么，
以及应用安装器怎么找 runtime、装完留下什么、卸载带走什么。
判据的实现与理由见 [架构](../../../docs/architecture.md) §7.3、§9、§12；
还没做的那一段（SDK 独立发布、包的来源信任与更新）在 [待办](../../../docs/todo.md) TD-013 与 TD-014。

### Requirement: 包是一个自带清单的归档，文件名由 id 定
依据：id 同时是包文件名前段、`~\.airship\data` 下的数据目录名、`airship://<id>/…` 里的那一段，
以及 `relaunchCommand` 里的一个命令行 token——这几处对字符的硬性要求叠在一起，
就是下面这条形状（实测的四类坏法见 `src/shared/app.ts` 的注释）。

#### Scenario: PK-001 id 不合形状，产包期就把规则念出来
- **WHEN** 包清单写 `id: "墨读"`，或写 `"Life"`、`"a b"`、`"a%20b"`
- **THEN** 产包失败，原因原样读得到「id "墨读" 不合形状：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符」
- **AND** 同一句里说明界面显示名写在 `name` 字段、那里不限字符
- **AND** runtime 侧读清单走的是同一份判定，产出的原因与产包器那句逐字相同

#### Scenario: PK-002 包清单读不出来就是不读，不当成"没有应用"
- **WHEN** 产物目录里没有 `manifest.json`，或那份文件不是合法 JSON
- **THEN** 产包失败，原因点出文件名与缺它还是解析不了（解析不了时带上解析器的话）
- **AND** 包根里不留任何半成品归档

#### Scenario: PK-003 包格式只对得上 runtime 认的那一档
- **WHEN** 包清单 `schemaVersion` 写成 `2`
- **THEN** 产包失败，原因念出「包清单 schemaVersion 只认 1，收到 2」并说明先对齐 runtime 的版本
- **AND** `sdkVersion` 缺失或非空字符串时同样在产包期失败，点名 sdkVersion

### Requirement: 包清单只写应用自己的事实
依据：与 AP-007 同一理由——图标是文件、顺序是应用之间的关系，两者都不是单个应用能决定的。

#### Scenario: PK-004 包清单里没有图标字段，也没有顺序字段
- **WHEN** 包清单出现 `iconPath`、`icon` 或 `order`
- **THEN** 产包失败，原因说清图标是包根那一张文件、顺序由 runtime 按名字典序定
- **AND** 归档根上没有 `icon.png` 时念「包里缺图标 icon.png：包根的源图只认那一张 png」
- **AND** 根上出现已退场的源图格式（`icon.svg` / `icon.jpg` / `icon.jpeg` / `icon.webp` / `icon.gif` / `icon.bmp`）时点名那些条目名并拒绝
- **AND** `icon.ico` 是 PK-036 那份外壳图标，不算源图，与 `icon.png` 同放包根是正常形状

#### Scenario: PK-005 清单里不许有 runtime 不认的键
- **WHEN** 包清单写了一个允许字段之外的键，例如 `author`
- **THEN** 产包失败，原因点出「包清单有 runtime 不认的键 "author"」
- **AND** `name`、`description` 缺或为空、
  `defaultWidth` 不是正整数，各自在产包期点名是哪个字段与收到了什么

### Requirement: 随包自带的后台程序按约定进包，归档根只有一份 `backend.js`
依据：后台不是清单字段——有没有它是包形状的事实。源项目在应用目录平铺
一份 `backend.ts` 或 `backend.js`（有且只有一处），产包流水把它编成包根 `backend.js`；
runtime 见到那个条目才起进程（通道侧契约见 `src/runtime/specs/backend.md`）。

#### Scenario: PK-040 应用目录里有后端入口，产出来的包根就有 `backend.js`
- **WHEN** 应用目录里有 `backend.ts`（或 `backend.js`），走产包流水编译并装包
- **THEN** 归档根上有 `backend.js` 条目，那是编好的 JS（`fork` 吃磁盘真文件，包里不许躺着一份没编的 TS）
- **AND** 应用目录里没有这个文件，归档根就不带 `backend.js`——manifest 里没有任何键表述它

#### Scenario: PK-041 `backend.ts` 与 `backend.js` 都在，产期响亮失败
- **WHEN** 应用目录里两份后端入口同时存在
- **THEN** 产包失败，原因原样读得到「后端入口只能有一份：backend.ts 与 backend.js 都在——留一个，复杂应用的目录归这个文件自己组织」

### Requirement: 包根另带一份 Windows 外壳认得的图标
依据：外壳（任务栏按钮、固定到任务栏那颗）读图标只认文件系统路径，既不认 asar 也不认 `airship://`，
更不认包内那张源图的格式。要让"一个归档自持"在真机上成立，图标就得随包备好（窗口侧的用法见 runtime.md SH-034）。

#### Scenario: PK-036 产出来的包根里有 `icon.ico`
- **WHEN** 产包完成，列出归档条目名
- **THEN** 根上有 `icon.ico`，那张多尺寸（16~256）的 ico 存在应用目录里、与源图一起被搬进产物目录
- **AND** 产包不转格式：没有能转图标的工具链的机器上，产出来的包根照样有它
- **AND** 应用安装器快捷方式用的就是包内这一份（取出来落进安装目录），安装器不再自己转第二遍

#### Scenario: PK-039 `icon.ico` 由应用作者自备，缺了响亮失败
- **WHEN** 产物目录里有源图但没有 `icon.ico`
- **THEN** 产包失败，原因原样读得到「包根没有 icon.ico：任务栏与快捷方式那颗外壳图标只认磁盘上的 .ico」
- **AND** 补进一张多尺寸的 `icon.ico` 后产包成功，包根就有它，且它不算第二张图标

### Requirement: 包里的东西只能在包内互相引用
依据：包要能在别人机器上离线跑起来，装到机器上的东西不能依赖网络，也不能依赖 runtime 目录树的形状。

#### Scenario: PK-006 入口里指到包外的引用，产包期一条都不放过
- **WHEN** 入口 html 的 `src` 或 `href` 是 `http(s)://…`、`//cdn…`、以 `/` 开头的绝对路径，或解析后越出包根的 `../…`
- **THEN** 产包失败，原因把那条引用原样念出来，并说明包必须自带全部东西
- **AND** `data:` 与 `blob:` 这类内联引用放行，锚点 `#…` 放行

#### Scenario: PK-007 注册失败不动磁盘一个字节
- **WHEN** 命令行指来的归档不合格（清单读不出来，或缺入口文件），注册被拒
- **THEN** 那个归档的字节一个没变，目录里不出现 `.tmp-` 或 `.prev-` 结尾的残留
- **AND** 注册是只读判定：失败多少次都不往包所在的目录写任何东西

### Requirement: 包的文档面只到自己那一个包
依据：`airship://<id>/<相对路径>` 是包对外唯一可读的文件面。
可达范围必须钉在那一个归档里：条目名越界一律拒，也不给"抹掉前缀再试一次"的回落。

#### Scenario: PK-014 越界与没注册的读取各有各的原话
- **WHEN** 有人请求 `airship://airship-life-game/../../windows/win.ini`，或请求一个没注册的 id
- **THEN** 前者解不出任何包外条目（`..`、`%2e%2e`、反斜杠三种写法都验过），后者念「没有注册这个应用：<id>」
- **AND** 两种都拿不到包外的内容，也不回落到入口文档

### Requirement: 应用安装器自己找 runtime，装完留一个快捷方式
依据：runtime 与应用的落点在同一棵树里——runtime 装 `~\.airship\runtime`，应用装 `~\.airship\apps\<id>\`
（都是每用户、不要管理员，PK-035）；数据在第三族 `~\.airship\data\<id>\`，由 runtime 管（见 `src/runtime/specs/storage.md`）。
安装器由 `code/make-app-installer.mjs` 从归档生成，界面措辞产安装器时从契约层烘进脚本。
安装与卸载真机走查归 `just app-installer`；这里钉的是生成出来的安装脚本里读得到的判据。

#### Scenario: PK-031 找 runtime 按顺序，找不到念原话不装
- **WHEN** 安装器启动，`AIRSHIP_PATH` 指着一个有 `airship.exe` 的目录，或没设它但固定目录里有
- **THEN** 用先找到的那一个；两处都没有时念「找不到 airship runtime：先装 runtime（固定装在 %USERPROFILE%\.airship\runtime），或把 AIRSHIP_PATH 指到它所在的目录。」
- **AND** 念完就中止，一个文件都不写

#### Scenario: PK-032 落点与快捷方式的命令行
- **WHEN** 安装完成
- **THEN** 归档落在 `~\.airship\apps\<id>\<id>.airship`，桌面快捷方式的目标是那个 runtime 目录里的 `airship.exe`，参数是归档的绝对路径，两段都带引号
- **AND** 快捷方式的图标用包内那份 `icon.ico`（PK-036 随包备好的那一份），不是 runtime 的图标

#### Scenario: PK-033 欢迎页念落点，带后台的念一句功能
- **WHEN** 安装器启动
- **THEN** 欢迎页念出应用名与安装目录，点下一页才开装
- **AND** 页面上读不到「它要的能力」这句，欢迎页只有落点与后台两句
- **AND** 归档根带 `backend.js`（PK-040）的，欢迎页念一句「跑它自带的后台程序」（措辞与 `BACKEND_PHRASE` 逐字一致，生成时烘进脚本）

#### Scenario: PK-034 卸载删归档留数据
- **WHEN** 走控制面板的卸载项或安装目录里的卸载器
- **THEN** 安装目录（归档、图标、卸载器）与桌面快捷方式被删掉
- **AND** `~\.airship\data\<id>` 里的设置与数据一个字节都不碰——安装脚本里读不到 `.airship\data` 这一段路径

#### Scenario: PK-035 两个安装器都装进 ~/.airship，都不要管理员
- **WHEN** 看生成出来的应用安装脚本与 runtime 的安装配置
- **THEN** 应用那份 `RequestExecutionLevel user`、落点 `$PROFILE\.airship\apps\<id>`；runtime 那份 perMachine 为假、落点钉死 `$PROFILE\.airship\runtime`，且不给换目录
- **AND** runtime 那份把安装模式拍成"当前用户"——不出现"为所有用户安装"那一档，也就不会出现文件落 `$PROFILE` 而卸载项写 HKLM 的分裂
- **AND** runtime 那份在安装模式那一步之前，把模板要读的那条安装路径也写成同一个固定目录——向导念的目录与文件真正落下的目录是同一个
- **AND** 两个安装器都不往 `Program Files` 写任何东西，runtime 安装包不带任何应用归档

<!--
  PK-027~030 于 2026-11-19 删除：首次直跑陌生包的能力确认卡片退场（使用者反馈双击应用先弹一张卡片太烦）。
  授权改由安装期一次完成——应用安装器装前念能力清单（PK-033），装完双击快捷方式直接开窗口，不再问。
  runConfirm 服务、run-confirm.json、契约层 runConfirmMessage/runConfirmDetail/runDeclined 一并删除。
  PK-008~013 于 2026-11-19 删除：runtime 不再扫磁盘认应用，包由命令行指来（SH-030~033），
  两个包根、优先级遮蔽、AIRSHIP_APPS_ROOT 整族失去对象。
  PK-015~019、PK-021~026 于 2026-11-19 删除：拖装与启动器里的卸载退场，
  装与卸改由应用自己的安装包承担（PK-031~035）。
  PK-037~038 于 2026-11-23 删除：backend 清单字段与 backend 能力位整族退场（能力位收的是宿主资源的授权，
  自带一段 Node 代码是包的构成物），改走 src/backend.ts|js → 包根 backend.js 的约定（PK-040~041）。
  PK-004 原有一条"归档根上的图标多于一张"于 2026-11-26 删除：源图格式收窄成只认 icon.png
  （svg / jpg / jpeg / webp 同日退场），名字钉死之后同一层不可能出现第二张同名文件，那条判据失去对象；
  改写为"缺 icon.png"与"出现已退场格式"两条各念一句原话。
  PK-007 原为"装包失败旧包原样还在"，现改写为直跑的只读判定。
  PK-033 原文"装之前念能力清单"于 2026-11-27 随 capabilities 整族退场改写：渲染进程没有沙箱，
  那份清单念了也拦不住什么；欢迎页只剩落点与后台两句。编号是稳定句柄，改写不换新号。
  PK-020 于 2026-11-07 删除：安装包改成纯 runtime、不带任何应用，"出厂根"这一族整个退场。
  编号按规矩不复用、不重排。
-->