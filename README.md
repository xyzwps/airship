# 飞船（airship）

飞船是一套装在自己电脑上的小工具：一个共享的 **airship runtime**（一个 Electron 运行时，像 JVM / .NET 那样装一次、你这个用户的应用都共用它），外面挂着八个各管一件事的应用——看电子书、读 PDF、勾待办、跑生命游戏、编排 FFmpeg、看 WSL 容器、编辑 SVG、浏览 S3 对象存储。

它想解决的是自用工具的那个老问题：每写一个小工具就得装一个 Electron、开一份仓库、配一遍构建，用两次就懒得再开。在飞船里，运行时只装一份，工具是**一个自己就能安装、装完有个快捷方式的小包**。

## 三个基本想法

**运行时和应用是分开的两件事。** runtime 装一次，钉死在 `~\.airship\runtime`（装进你自己的主目录，不要管理员）。应用打包成 `<id>.airship`（其实是一个 zip 换了扩展名），由**它自己的安装器**装进同一棵树里的 `~\.airship\apps\<id>\`（不要管理员），并在桌面和开始菜单留一枚快捷方式。快捷方式的目标就是 runtime 的 `airship.exe` 加上那份包的路径——双击它，runtime 就开出这个应用的窗口。

**runtime 不认识任何具体应用。** 跑哪些包由命令行决定（`airship.exe <id>.airship`，可以一次指多份），注册一份、开一个窗口。安装包的产物里没有一行应用代码，runtime 自己也没有界面。所以加一个应用、更新一个应用、卸掉一个应用，都不需要重新出 runtime 的安装包——runtime 是纯的，应用是外挂的。

**一个应用一个窗口一个渲染进程。** 应用只能通过 `window.airship` 这一面碰系统，而且能碰什么必须先写在自己的清单里声明；没声明的一律拒绝，并给出读得懂的原因。于是改一个应用不用管其余七个，一个应用崩了也不带崩别人。多个应用共用一个 runtime 进程：第二次启动会把包路径转发给已在跑的那一份，同 id 同包只是把窗口唤到前面。

数据由 runtime 统一托管在各应用自己的目录里（`~\.airship\data\<id>\`）。应用安装器卸载时只删安装目录、快捷方式与卸载项，**不动**这份数据。

## 里面装着什么

| | 名称 | 做什么 |
| --- | --- | --- |
| `books` | 墨读 | EPUB / MOBI 电子书书架与阅读器 |
| `pdf` | PDF | PDF 阅读，与墨读共用同一个书架 |
| `dagogo` | 打勾勾 | 每天要做的事，勾掉就行 |
| `life` | 生命游戏 | 在 100 / 200 / 300 的网格上跑康威生命游戏 |
| `vcp` | vcp | FFmpeg 编排台：选流、加处理链、看命令、跑队列 |
| `wsld` | wsld | WSL 容器与镜像的图形外壳（仅 Windows） |
| `albedo` | Albedo | SVG 编辑工作台：形状与路径、布尔运算、导出 SVG/PNG |
| `s3` | S3 | 连 S3 兼容的对象存储：浏览、上传下载、预览、删除 |

## 怎么用

1. **装 runtime**：双击 `airship-runtime-Setup-<版本>-x64.exe`，它一定装进 `~\.airship\runtime`（不要管理员，每个 Windows 用户各装自己那一份）。装完没有界面、没有快捷方式——runtime 是给人双击应用快捷方式时在背后跑起来的，不是单独打开的。
2. **装应用**：双击某个应用的 `<id>-Setup-<版本>.exe`。它先去找 runtime（`AIRSHIP_PATH` 环境变量优先，否则 `~\.airship\runtime`），找不到就念一句"没找到 airship runtime"中止；找到了就把包放进 `~\.airship\apps\<id>\`，留好快捷方式。
3. **开应用**：双击桌面或开始菜单那枚快捷方式，窗口直接开——运行期没有任何确认闸门，授权在安装期一次完成。

没有代码签名，第一次运行会被 SmartScreen 拦一道，点"仍要运行"。

## 想自己写一个应用

从范本造出来，runtime 侧任何文件都不用改：

```bash
just new-app hello 你好        # 复制 templates/app → src/apps/hello
# 改三处：app.ts（这个应用的清单）、样式、规格册
just build-apps                # 产 dist-apps/hello.airship
just app-installer hello       # 产 release/apps/hello-Setup-<版本>.exe
```

应用面向 runtime 的那一面是 SDK：标题栏、主题落地、窗口留白、占位图都由宿主管，作者只需要写自己的正文，以及在清单里声明要用的共享数据区（`sharedNamespaces`）。要碰这台机器上的外部程序，就随包带一份后端（`backend.ts`）自己发现和拉起，runtime 不认识任何具体工具。清单只写"这个应用自己的事实"，不写图标路径、排序这类表现形式。主题三档（亮 / 暗 / 跟随系统）由标题栏那颗键改，各应用各记各的。

## 开发这个仓库

要 Windows、Node.js `^20.19.0 || >=22.12.0`、[just](https://github.com/casey/just) 和 Git Bash：

```bash
npm install
just dev life   # 直跑那一个应用，改代码热更（文档走 dev server，清单与图标走包）
just build      # 打 runtime 的安装包 + 产各应用的包（产物互不包含）
just check      # 类型 + 单测 + 册子差集
```

`just` 不带参数列出全部配方，[justfile](justfile) 是命令的唯一真源（`package.json` 里没有 scripts）。

每个功能在动之前先有一份规格册：四档结构、每条场景带稳定编号、只写可观察的结果（界面读得到哪句话、落盘文件是什么形状），实现细节一律不写。用例标题以同一个编号开头，`just casecov` 做双向差集，所以"册子里承诺了但没做"和"偷偷测了但没承诺"都过不了检查。界面观感不进册子，靠 `just shot` 逐窗口截图走查。

再往下读：给代理的说明在 [AGENTS.md](AGENTS.md)，架构理由与七条不变量在 [docs/architecture.md](docs/architecture.md)，用户可见契约的索引在 [docs/specs/index.md](docs/specs/index.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。