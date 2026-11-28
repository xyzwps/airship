# app-model

## Purpose
一个应用的对外形状与发现规矩：清单是文件约定、缺件在产包期与注册期炸、加应用不改 runtime。
架构理由见 [架构](../../../docs/architecture.md) §7，这本册子钉的是结果。

### Requirement: 应用由目录里的文件定义，不靠 runtime 写名单
#### Scenario: AP-001 四份文件缺一件，产包期就说清缺什么
- **WHEN** 某应用目录没有 `app.ts`、没有 `index.html`、没有 `main.tsx`，或源图没有
- **THEN** 报错逐条列出缺的是哪一份（点名 `apps/<id>/index.html`、`apps/<id>/main.tsx`、`apps/<id>/icon.png`）
- **AND** 源图只认 `icon.png` 那一张 png（svg / jpg / jpeg / webp 于 2026-11-26 退场）
- **AND** 不留"注册了一半"的状态：有问题就不产出这个包

#### Scenario: AP-002 应用目录根留着已退场的源图格式，产包期点名拒绝
- **WHEN** 某应用目录根上放着 `icon.svg`（jpg / jpeg / webp / gif / bmp 同档）
- **THEN** 产包失败，报错点出那张的名字，说清源图只认 `icon.png`、要作者在外部工具里重出
- **AND** 补上 `icon.png` 并删掉旧的那张之后产包成功

#### Scenario: AP-003 清单不写 id：id 由产包期从项目名注入
- **WHEN** `app.ts` 里出现 `id` 字段
- **THEN** 产包期点名拒绝：id 的唯一真源是项目 `package.json` 的 `name`（本仓即应用目录名），这一行该删掉
- **AND** 注入后的 `manifest.json` 里 id 等于归档名；id 的形状（`APP_ID_PATTERN`）产包期与注册期过同一份判据

#### Scenario: AP-004 应用 id 不允许重复
- **WHEN** 同一份活动包表里进来了第二份同 id 的清单
- **THEN** 注册报错点出重复的那个 id 与出问题的路径
- **AND** 同 id 指来另一份归档时拒，念清两份各在哪（SH-033）

#### Scenario: AP-015 每个真清单都过同一份形状判据
- **WHEN** 把仓库里八份 `app.ts` 按产包规矩投影成包清单（id 取自目录名）再过一遍判据
- **THEN** 一条原因都没有，id 全部合 `APP_ID_PATTERN` 的形状
- **AND** 八个 id 互不重复

### Requirement: 清单里的字段只写应用自己的事实
#### Scenario: AP-006 平台字段只用认识的名字，不写就是全平台
- **WHEN** 清单写 `platforms: ['windows']`
- **THEN** 这台机器不是 windows 时判定为"用不了"，原因说清它在哪些平台可用、这台机器是什么
- **AND** 没写 `platforms` 的应用在任何平台都判为可用；写了 runtime 不认识的平台名，注册期报错

#### Scenario: AP-007 清单里没有图标字段，也没有顺序字段
- **WHEN** 看清单类型与真实清单
- **THEN** 找不到 `iconPath` 之类的图标字段，也找不到 `order` 之类的排名字段
- **AND** 图标是文件、顺序由 runtime 按名字典序定

#### Scenario: AP-012 默认窗口尺寸是清单字段，值必须像话
- **WHEN** 清单写 `defaultWidth: 900` 与 `defaultHeight: 620`
- **THEN** 注册收下它，首次开窗口照这两个数开（判据见 `src/runtime/specs/runtime.md` SH-015）
- **AND** 写成 `0`、负数、小数或非数字，注册期直接报错，原因念得出是哪个字段与收到的值
- **AND** 不写就等于全按 runtime 的默认尺寸，两个字段各自独立可缺

### Requirement: 命令行指来的包就是应用名单
依据：runtime 不在构建期 glob 应用目录，也不在运行期扫磁盘（那都意味着"名单"与"这次跑什么"分家）。
名单只有一份，住在主进程的活动包表里；渲染侧问它要，两侧不再各扫一遍。

#### Scenario: AP-009 显示顺序由 runtime 定，两个应用自己说不了话
- **WHEN** 取截图工装与注册表读法的遍历顺序
- **THEN** 都是按应用名的字典序（中文排序），应用清单里没有也不能有排名字段

#### Scenario: AP-010 加一个应用不改动 runtime 的任何文件
- **WHEN** 扫 runtime 主进程、preload 与 SDK 里的源码
- **THEN** 找不到任何具体应用 id 的字面量，也找不到 `apps/<id>/` 这种路径
- **AND** 每个应用目录该有的四份文件都在；归档名 `<id>.airship` 里的 id 来自目录名，不来自清单
- **AND** 入口文档引的是相对路径的 `./main.tsx`（包换到哪个目录、哪个协议下都解得开）

### Requirement: 包要离得开这个仓库
依据：一个包会被装进另一份 runtime 里跑。应用直连 runtime 的实现，"包自持"就是假的——
那份包再也离不开这个仓库。

#### Scenario: AP-013 应用不 import runtime 的实现，SDK 也不 import runtime 或应用
- **WHEN** 扫各应用与 SDK 源码里的 import
- **THEN** 找不到指向 `src/runtime/**` 或 `@airship/runtime` 的一条
- **AND** SDK 里也找不到指向某个应用包内部的一条

#### Scenario: AP-014 CSP 只有一份，构建时注入，应用入口文档里不许自己写
- **WHEN** 看 `src/sdk/csp.ts` 与各应用目录的 `index.html`
- **THEN** 产线用的一条与开发用的一条各只有一处定义，注入器按构建还是开发选一条
- **AND** 八个应用的 `index.html` 里都找不到 `Content-Security-Policy` 那一条

#### Scenario: AP-016 每个区都是真包，范本复制得出去
- **WHEN** 看 runtime、SDK、CLI、契约层、两个共享包与八个应用各自目录下的 `package.json`
- **THEN** 每份都在，名字都带 `@airship/` 前缀；SDK、CLI 与契约层三份写着公开发布，其余都写着不发布
- **AND** 应用的 `package.json` 里 SDK 与 react 记在 `devDependencies`——运行时机器上不需要装着它们
- **AND** 根那份只声明工作区，没有 `scripts`（命令的唯一真源仍是 justfile）
- **AND** 仓库里再没有 `@shared/…`、`@sdk/…`、`@apps/…` 这类手写别名说明符

<!--
  AP-008 于 2026-11-19 删除：runtime 不再扫磁盘，"注册表、包根目录、仓库清单三处同一批"失去对象——
  活动包表只装命令行指来的包，与仓库里有几份清单无关。
  AP-017 于 2026-11-24 删除：`net` 能力位整族退场，CSP 只剩产包与开发两档，"按清单分档放宽外连"失去对象——
  要连外部服务的应用把请求交给随包自带的后端进程（backend.md），那与窗口文档的 CSP 无关。
  AP-002 于 2026-11-26 改写：源图格式收窄成只认 icon.png，"同时放两张"在文件名层面不再可能，
  那条判据改成"目录根留着已退场格式就点名拒绝"。
  AP-003 于 2026-11-27 改写：AppMeta 不再声明 id——写两遍就有可能写岔，唯一真源收成项目 package.json 的
  name（本仓即目录名），产包注入 manifest.json；"清单 id 与目录名不一致"那条对账随字段一起退场。
  AP-005 于 2026-11-27 删除：清单不再声明外部工具（tools 字段整族取消），
  "工具名要合一张表"的核对失去对象——外部命令由应用自带的后端进程自己找、自己跑。
  AP-011 于 2026-11-27 删除：capabilities 整族退场，"用了哪个域就得声明哪个能力"的核对失去对象。
  编号不复用、不重排。
-->
