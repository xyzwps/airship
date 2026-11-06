# 待办（这个仓库里唯一的一份）

这里集中记 airship 所有"还没做 / 做不了 / 这期不做"的事。**别处不再抄内容**：
架构文档、发布文档、册子索引里只留状态标记或一句指回这里的话，细节与理由都在这本上。

规矩三条：

- 编号 `TD-###` 是稳定句柄，不复用、不重排；册子里的 Scenario 编号（SH-010 那种）另算一套。
- 做完了**整条删掉**，不是标成"已完成"——留着的历史由提交信息承担，写清关掉的是哪一条。
- 每条只写三件事：这是什么、为什么还挂着、动它要碰哪里。
- 没有人做出决定时，你不可以擅自记录任何 todo！

---

## 壳与发布

### TD-001 任务栏上六个应用还是一个「飞船」

三个应用窗口的任务栏按钮、预览图与名字全是壳的样子，因为它们共用同一个宿主身份。

为什么挂着：`src/shell/main/windows.ts` 里写的是 `window.setAppUserModelId?.(...)`，而那个方法只挂在 `app`
（进程级）上，BrowserWindow 没有——可选链把失败吞成一次空操作，代码看着做了、真机什么都没发生。

动它要碰四处（缺一不可，2026-11-06 做到第二件就撤了，路线已验通）：

1. 窗口身份改用 `win.setAppDetails({ appId, appIconPath, relaunchCommand, relaunchDisplayName })`；
2. 每应用一张 `.ico`——图标由系统外壳读，asar 里的路径它不认，得靠 `extraResources` 拷成
   `resources/app-icons/<id>.ico`。烘法验过能用：`@resvg/resvg-js` 把 SVG 出成 256 PNG，再交给 Pillow
   以最大档为基准出多尺寸 ico（Pillow 不认 SVG、无头 Chrome 截内联 SVG 出空白，这两个坑都绕开了）；
3. 壳要认 `--app=<id>` 启动参数（现在只认 `--shot`），`second-instance` 也要按它唤对应应用，
   否则固定上去的按钮点了只是把启动器顶到前台；
4. 开始菜单给每个应用一枚带同样 AUMID 的快捷方式。electron-builder 的 NSIS 模板只用裸 `CreateShortCut`，
   没有给 `.lnk` 写 `System.AppUserModel.ID` 的能力（那是 IPropertyStore，要 ShellLink 插件），
   还没找到"不额外下插件"的解法。

顺带要修的假绿：`src/shell/tests/appWindowCreate.test.ts` 的替身窗口把 `setAppUserModelId` 一起写了进去，
于是 SH-010 一直绿着。替身只能实现真 API 面上存在的方法。

来源：原记在 `docs/architecture.md` §7 表格「任务栏」那行与 §14；那两处现在只留状态标记指回这里。

### TD-002 阶段 C：应用与壳同仓同构建

"改一个应用不用管其他"已经做到（加应用 = 加目录，壳侧零改动），但构建还是一起构建——改一个应用要重出整个安装包。
要做得把应用变成运行时从磁盘加载的包。来源：`docs/architecture.md` §14 与 `docs/release-packaging.md`。

### TD-003 没有代码签名证书

第一次运行 Windows SmartScreen 会拦一道"未知发布者"，点"仍要运行"即可。要消掉这道提示得买 OV/EV 证书，
或者走 Microsoft Store。来源：`docs/release-packaging.md` 没做的事。

### TD-004 没有自动更新链路

`latest.yml` 只是 electron-builder 的产物，应用里没接 `electron-updater`——发新版目前只能重新拷安装包。
来源：`docs/release-packaging.md` 没做的事。

### TD-005 想要 Inno Setup 那一档观感

现在用 NSIS。要 Inno 的观感（同一份 `.isl` 双语文案、LZMA2 极限压缩），得先本机装 Inno Setup 6
（`winget install JRSoftware.InnoSetup`），再照 wslc-desktop 的 `wsld.iss` 写一份 `installer/airship.iss`，
拿 `release/win-unpacked/` 当输入。来源：`docs/release-packaging.md` 没做的事。

### TD-006 多窗口的内存回收

窗口数不设上限，六个应用全开约 500 MB。真觉得吃紧再加"同应用多窗口"或闲置回收策略——现在还没有触发这件事的症状。
来源：`docs/architecture.md` §14。

---

## 应用与能力：原版有、这里先没有

这三块都属 wsld（容器台）。册子索引里"先不开的册子"那几本与它们一一对应，内容以这里为准。

### TD-007 `run` 命令编排（`run-builder`）

40 余字段的拼装、校验与反解，是原版量最大的一块。来源：`docs/specs/index.md`、`docs/architecture.md` §14。

### TD-008 registry mirror（`registry-mirror`）

镜像源路径改写与 pull 后改名。来源：`docs/specs/index.md`「先不开的册子」。

### TD-009 拉取实时进度（`pull-progress`）—— 这条是能力缺口，不是省事

原版逐层进度靠 ConPTY 伪终端把 `wslc` 当全屏应用来读（`VtScreenTracker` 那套屏幕模型），
而本项目 `proc` 只有管道分块——没有 TTY 就没有那一层。要么以后给 `proc` 加伪终端能力，
要么按普通管道输出重做进度呈现。来源：`docs/architecture.md` §14。

### TD-010 wsld 自己的设置页（`settings`）

本期只留镜像列表那几颗键，走壳的 `src/shell/specs/storage.md`。来源：`docs/specs/index.md`。

---

## 验证缺口与实测发现

### TD-012 EPUB 翻页延迟没单独采样

现在只有"打开到首屏"的数字（见 `docs/architecture.md` §3.1 与 `just shot` 打的 perf 行）。
翻页要另打标记。来源：`docs/architecture.md` §14。

---

## 不做，只留理由（别再当 TODO 找上门）

- **界面语言（`i18n`）**：本项目只做中文；换皮与语言归壳自己。
- **壳的窗口与导航册子（`shell.md` / `theme.md`）**：不搬原版那两本，窗口、导航、换皮由 airship 壳的
  SH / TH 两本管（见 `docs/specs/index.md` 的能力索引）。
