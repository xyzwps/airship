# 飞船（airship）

一个 Electron 壳，里面装着八个自用应用。一个应用一个窗口一个渲染进程；每个应用是一个 `airship` 包（zip 归档 `<id>.airship`），运行期由壳扫出来——壳的产物里没有应用代码。

## 应用

| id | 名称 | 做什么 |
| --- | --- | --- |
| `books` | 墨读 | EPUB / MOBI 电子书书架与阅读器 |
| `pdf` | PDF | PDF 阅读，与墨读共用同一个书架 |
| `dagogo` | 打勾勾 | 每天要做的事，勾掉就行 |
| `life` | 生命游戏 | 在 100 / 200 / 300 的网格上跑康威生命游戏 |
| `vcp` | vcp | FFmpeg 编排台：选流、加处理链、看命令、跑队列 |
| `wsld` | 容器台 | WSL 容器与镜像的图形外壳（仅 Windows） |
| `albedo` | Albedo | SVG 编辑工作台：形状与路径、布尔运算、导出 SVG/PNG |
| `s3` | S3 | 连 S3 兼容对象存储：浏览、上传下载、预览、删除 |

## 目录

```
src/shell              主进程、preload、启动器；不认识任何具体应用
src/sdk               宿主（标题栏 / 主题 / 留白 / 占位）、CSP、测试工装
src/apps/<id>         八个应用，各自自持 index.html 与清单 app.ts
src/shared/contract   契约、清单类型、注册与包形状的规矩
src/shared/library    共享书库（墨读与 PDF 同一份数据）
src/shared/textdecode 中文解码
templates/app         新应用范本
code/                 工具脚本（产包、造应用、出图标、自检）
docs/                 架构说明、规格册索引、待办
```

每个区都是一个 npm 包，说明符一律写包名（`@airship/...`）；应用与 SDK 都不许 import `src/shell/**`。

## 环境

Windows，Node.js `^20.19.0 || >=22.12.0`（Vite 8 的要求；本机跑的是 25.x），[just](https://github.com/casey/just)，以及 Git Bash（justfile 里写死了它的路径）。Electron 与 electron-builder 的二进制走 npmmirror 镜像，已在 `.npmrc` 里配好。

```bash
npm install
```

## 命令

命令的唯一真源是 [justfile](justfile)，`just` 不带参数就列出全部配方。

```bash
just dev            # 开发（先产各应用的包）
just build-apps     # 产各应用的 airship 包到 dist-apps/
just build-shell    # 打壳的安装包（清场 → 编译 → NSIS → 自检）
just build          # 两条都跑，产物互不包含
just check          # 提交前一轮：类型 + 单测 + 册子差集
just shot           # 逐窗口截图，顺带证明包真能装进壳跑起来
just new-app hello 你好   # 从范本造一个新应用
```

## 装一个应用

只有一条路：把 `<id>.airship` 拖到启动器上。落点是 `%LOCALAPPDATA%\airship\apps`，装完只刷新格子、不自动开窗口。安装包是纯壳，里面不带任何应用。

## 规格册

每个区自带 `specs/` 与 `tests/`：契约按四档结构写（Purpose → Requirement → Scenario → WHEN/THEN），每条场景带稳定编号，只写可观察结果。用例标题以编号开头，`just casecov` 做双向差集——册里有号没用例等于未实现，用例挂了号册里没有就是私测。

界面观感不进册子，那是 `just shot` 截图走查的事。

给代理的说明见 [AGENTS.md](AGENTS.md)，架构理由见 [docs/architecture.md](docs/architecture.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。目前没有代码签名，第一次运行会被 SmartScreen 拦一道。
