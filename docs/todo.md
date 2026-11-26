# 待办（这个仓库里唯一的一份）

这里集中记 airship 所有"还没做 / 做不了 / 这期不做"的事。**别处不再抄内容**：
架构文档、发布文档、册子索引里只留状态标记或一句指回这里的话，细节与理由都在这本上。

规矩三条：

- 编号 `TD-###` 是稳定句柄，不复用、不重排；册子里的 Scenario 编号（SH-010 那种）另算一套。
- 做完了**整条删掉**，不是标成"已完成"——留着的历史由提交信息承担，写清关掉的是哪一条。
- 每条只写三件事：这是什么、为什么还挂着、动它要碰哪里。
- 没有人做出决定时，你不可以擅自记录任何 todo！

---

- [ ] capabilities 含义太模糊了，需要细化

## runtime 与发布

### TD-001 快捷方式（`.lnk`）上还没有 per-app 的身份

窗口的任务栏身份已经按应用分开了：`setAppDetails` 逐窗口给 `dev.xyzwp.airship.<id>`、图标取包内那份
随包备好的 `icon.ico`、重启动作与快捷方式同形（判据 SH-010 / SH-034 / SH-035，备好的那一份见 PK-036）。
原先列的四处里前三处 2026-11-19 落了，**只剩第四处**：应用安装器落的 `.lnk` 上没有 `System.AppUserModel.ID`。

为什么挂着：`code/make-app-installer.mjs` 用的是 NSIS 裸 `CreateShortcut`，它写不了 `.lnk` 的属性——
那是 `IPropertyStore`，要 ShellLink 那一类插件，还没找到"不额外下插件"的解法。
症状也没验过：窗口身份已经分开，桌面与开始菜单那两颗、以及固定到任务栏的按钮会不会仍归到 runtime 一组，
要在真机上固定一次才知道。

动它要碰哪里：`code/make-app-installer.mjs` 的 `installerScript` 里那两处 `CreateShortcut`（桌面 + 开始菜单），
要么带一枚能写 `.lnk` 属性的 NSIS 插件，要么走 `IShellLink` 那条 COM 路。

### TD-013 SDK 独立发布与版本协商

包按某个 SDK 版本构建，却要跑在用户机器上任意一个 runtime 版本里——这条边今天仍旧靠"同仓同一次构建"对齐。
"SDK 独立发布"这半已于 2026-11-23 落地：`@airship/sdk` 与 `@airship/contract` 的 `exports` 指各自 `dist/`，
`just build-libs` 编译，`sdkVersion` 取 `src/sdk/package.json` 那份，版本号独立演化。
还差三样：runtime 侧对 `requiresRuntime` 的判定（现在只记录不判）、
不兼容时直跑前读得到的那句原因（而不是点开一个白屏）、runtime 侧 API 只加不改不删的纪律。
改 SDK 与契约层的导出等于改公开面。
来源：2026-11-07 拆包时定下的第三步（A/B/C/D 四档已落，这一步是它的后续）。

### TD-014 装包的来源信任与更新

装包现在只有一条路：跑应用自己的每用户安装器（`code/make-app-installer.mjs`，PK-031~035）——
找 runtime、念能力清单、落进 `%LOCALAPPDATA%\airship\apps\<id>\`、留快捷方式。
卸载删安装目录 / 快捷方式 / HKCU 注册表，不碰数据（PK-034）。
从前"拖进启动器就装"与"启动器顶栏管理键卸载"那一族随启动器退场了；"退回出厂版"也不存在——
安装包是纯 runtime，没有出厂那份可退。还缺两件事，都在这条入口变方便之后才更要紧：

1. **来源信任**。现在任何归档只要形状合格就装，runtime 与安装器都不认它出自谁。要有签名或校验和，
   前提是 TD-003 那张证书。（安装器旁边那份 `.sha256` 只防传输被改，不证明来源。）
2. **更新**。装了 0.3.0 之后没人告诉你有 0.4.0；这条和 TD-004（runtime 自己的自动更新）是同一条链的两半。
   应用版本独立演化，更新一个应用 = 重跑它的安装器覆盖那份归档，今天全靠人手动。

来源：2026-11-07 拆包路线的第四、五步；2026-11-19 runtime 化后装包入口换成应用安装器。

### TD-003 没有代码签名证书

第一次运行 Windows SmartScreen 会拦一道"未知发布者"，点"仍要运行"即可。要消掉这道提示得买 OV/EV 证书，
或者走 Microsoft Store。runtime 安装包与应用安装器都没签名。来源：`docs/release-packaging.md` 没做的事。

### TD-004 没有自动更新链路

`latest.yml` 只是 electron-builder 的产物，runtime 里没接 `electron-updater`——发新版目前只能重新拷安装包。
来源：`docs/release-packaging.md` 没做的事。

### TD-005 想要 Inno Setup 那一档观感

现在 runtime 与应用安装器都用 NSIS。要 Inno 的观感（同一份 `.isl` 双语文案、LZMA2 极限压缩），
得先本机装 Inno Setup 6（`winget install JRSoftware.InnoSetup`），再照 wslc-desktop 的 `wsld.iss` 写一份
`installer/airship.iss`，拿 `release/win-unpacked/` 当输入。来源：`docs/release-packaging.md` 没做的事。

### TD-006 多窗口的内存回收

窗口数不设上限，八个应用各开一扇。每窗口工作集的隔离实测见 `docs/architecture.md` §3.1
（本轮 86~112 MB 一扇）；八扇全开的累计数没单独采过。真觉得吃紧再加"同应用多窗口"或闲置回收策略——
现在还没有触发这件事的症状。来源：`docs/architecture.md` §14。

---

## 应用与能力：原版有、这里先没有

这三块都属 wsld。册子索引里"先不开的册子"那几本与它们一一对应，内容以这里为准。

### TD-008 registry mirror（`registry-mirror`）

镜像源路径改写与 pull 后改名。来源：`docs/specs/index.md`「先不开的册子」。

### TD-009 拉取实时进度（`pull-progress`）—— 这条是能力缺口，不是省事

原版逐层进度靠 ConPTY 伪终端把 `wslc` 当全屏应用来读（`VtScreenTracker` 那套屏幕模型），
而本项目 `proc` 只有管道分块——没有 TTY 就没有那一层。要么以后给 `proc` 加伪终端能力，
要么按普通管道输出重做进度呈现。来源：`docs/architecture.md` §14。

### TD-010 wsld 自己的设置页（`settings`）

本期只留镜像列表那几颗键，走 runtime 的 `src/runtime/specs/storage.md`。来源：`docs/specs/index.md`。

---

## 验证缺口与实测发现

### TD-012 EPUB 翻页延迟没单独采样

现在只有"打开到首屏"的数字（见 `docs/architecture.md` §3.1 与 `just shot` 打的 perf 行）。
翻页要另打标记。来源：`docs/architecture.md` §14。

---

## 不做，只留理由（别再当 TODO 找上门）

- **界面语言（`i18n`）**：本项目只做中文；换皮与语言归 runtime 自己。
- **原版的窗口与导航册子（`shell.md` / `theme.md`）**：不搬原版那两本，窗口、直跑、换皮由 airship runtime
  自己的 `runtime.md`（SH）与 `theme.md`（TH）管（见 `docs/specs/index.md` 的能力索引）。