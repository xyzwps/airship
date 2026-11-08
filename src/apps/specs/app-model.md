# app-model

## Purpose
一个应用的对外形状与发现规矩：清单是文件约定、缺件在产包期与注册期炸、加应用不改壳。
架构理由见 [架构](../../../docs/architecture.md) §7，这本册子钉的是结果。

### Requirement: 应用由目录里的文件定义，不靠壳写名单
#### Scenario: AP-001 四份文件缺一件，产包期就说清缺什么
- **WHEN** 某应用目录没有 `app.ts`、没有 `index.html`、没有 `main.tsx`，或图标一张都没有
- **THEN** 报错逐条列出缺的是哪一份（点名 `apps/<id>/index.html`、`apps/<id>/main.tsx`、`apps/<id>/icon.svg`）
- **AND** 说明图标 png / jpg / jpeg / webp 也接受
- **AND** 不留"注册了一半"的状态：有问题就不产出这个包

#### Scenario: AP-002 图标有且只能有一张
- **WHEN** 某应用目录里同时放了 `icon.svg` 与 `icon.png`
- **THEN** 报错点出这两张的名字，说清"只留一张"

#### Scenario: AP-003 清单 id 必须等于目录名
- **WHEN** 目录叫 `foo`，清单里 id 写成 `bar`
- **THEN** 报错同时念出目录名与清单 id，产包期、主进程与用例三处用的是同一份规则
- **AND** 包目录名等于 `<id>.airship`

#### Scenario: AP-004 应用 id 不允许重复
- **WHEN** 两份清单声明同一个 id
- **THEN** 注册报错点出重复的那个 id 与出问题的路径
- **AND** 包根里同 id 的后扫到的那一份不装，原因说清是哪一份占住了它（PK-008）

#### Scenario: AP-015 每个真清单都过同一份形状判据
- **WHEN** 把仓库里六份 `app.ts` 原样投影成包清单再过一遍判据
- **THEN** 一条原因都没有，id 全部合 `APP_ID_PATTERN` 的形状
- **AND** 六个 id 互不重复

### Requirement: 清单里的字段只写应用自己的事实
#### Scenario: AP-005 清单里不写壳不认识的工具
- **WHEN** 清单 `tools` 里出现工具表以外的名字
- **THEN** 注册报错，原因念出这个名字并列出壳只认哪些

#### Scenario: AP-006 平台字段只用认识的名字，不写就是全平台
- **WHEN** 清单写 `platforms: ['windows']`
- **THEN** 这台机器不是 windows 时判定为"用不了"，原因说清它在哪些平台可用、这台机器是什么
- **AND** 没写 `platforms` 的应用在任何平台都判为可用；写了壳不认识的平台名，注册期报错

#### Scenario: AP-007 清单里没有图标字段，也没有顺序字段
- **WHEN** 看清单类型与真实清单
- **THEN** 找不到 `iconPath` 之类的图标字段，也找不到 `order` 之类的排名字段
- **AND** 图标是文件、顺序由壳按名字典序定

#### Scenario: AP-012 默认窗口尺寸是清单字段，值必须像话
- **WHEN** 清单写 `defaultWidth: 900` 与 `defaultHeight: 620`
- **THEN** 注册收下它，首次开窗口照这两个数开（判据见 `src/shell/specs/shell.md` SH-015）
- **AND** 写成 `0`、负数、小数或非数字，注册期直接报错，原因念得出是哪个字段与收到的值
- **AND** 不写就等于全按壳的默认尺寸，两个字段各自独立可缺

### Requirement: 磁盘上的包就是应用名单
依据：壳不再在构建期 glob 应用目录（那意味着改一个应用要重出整个安装包）。
名单只有一份，住在主进程；渲染侧问它要，两侧不再各扫一遍。

#### Scenario: AP-008 注册表、包根目录、仓库清单三处是同一批
- **WHEN** 分别问主进程注册表"有哪些应用"、数包根里的 `<id>.airship` 目录、读仓库里的 `apps/*/app.ts`
- **THEN** 三处的 id 集合相同
- **AND** 扫到零个包时这条判据直接失败，不允许"恰好一个应用都没有"算通过

#### Scenario: AP-009 显示顺序由壳定，两个应用自己说不了话
- **WHEN** 取启动器格子与截图工装的遍历顺序
- **THEN** 都是按应用名的字典序（中文排序），应用清单里没有也不能有排名字段

#### Scenario: AP-010 加一个应用不改动壳的任何文件
- **WHEN** 扫主进程、桥与壳界面里的源码
- **THEN** 找不到任何具体应用 id 的字面量，也找不到 `apps/<id>/` 这种路径
- **AND** 每个应用目录该有的四份文件都在，id 与目录名一致
- **AND** 入口文档引的是相对路径的 `./main.tsx`（包换到哪个根、哪个协议下都解得开）

#### Scenario: AP-011 应用用到的契约域都在清单里声明过
- **WHEN** 扫各应用源码里的契约调用点（`api.settings.`、`api.proc.`、`api.tray.` 这些域）
- **THEN** 每个被用到的域都 requiring 到清单里对应的能力；用了 `api.tools.` 的应用必须声明 `proc` 与那个工具
- **AND** 一个都不缺——缺了就是"跑起来才发现被拒"的隐患

### Requirement: 包要离得开这个仓库
依据：一个包会被装进另一份壳里跑。应用直连壳的实现，"包自持"就是假的——
那份包再也离不开这个仓库。

#### Scenario: AP-013 应用不 import 壳的实现，SDK 也不 import 壳或应用
- **WHEN** 扫各应用与 SDK 源码里的 import
- **THEN** 找不到指向 `src/shell/**` 或 `@airship/shell` 的一条
- **AND** SDK 里也找不到指向某个应用包内部的一条

#### Scenario: AP-014 CSP 只有一份，构建时注入，应用入口文档里不许自己写
- **WHEN** 看 `src/sdk/csp.ts` 与各应用目录的 `index.html`
- **THEN** 产线用的一条与开发用的一条各只有一处定义，注入器按构建还是开发选一条
- **AND** 六个应用的 `index.html` 里都找不到 `Content-Security-Policy` 那一条

#### Scenario: AP-016 每个区都是真包，范本复制得出去
- **WHEN** 看壳、SDK、契约层、两个共享包与六个应用各自目录下的 `package.json`
- **THEN** 每份都在，名字都带 `@airship/` 前缀，且都写着不发布
- **AND** 应用的 `package.json` 里 SDK 与 react 记在 `devDependencies`——运行时机器上不需要装着它们
- **AND** 根那份只声明工作区，没有 `scripts`（命令的唯一真源仍是 justfile）
- **AND** 仓库里再没有 `@shared/…`、`@sdk/…`、`@apps/…` 这类手写别名说明符

#### Scenario: AP-017 注入的 CSP 按清单分档：声明了 `net` 的才放宽外连
- **WHEN** 比对注入给清单里声明了 `net` 的应用与没声明的应用的那条 CSP
- **THEN** 前者的 `connect-src` 带着 `http:` 与 `https:`，后者仍是收紧的那条
- **AND** 两档的 `script-src` 与 `frame-src` 都没放宽——能连外网不等于能加载外站脚本
