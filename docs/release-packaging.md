# 打包分发（Windows 安装包）

一条命令产出一个 `setup.exe`，拷给别人双击安装即可。**客户机不需要装 Node、不需要装 Electron。**

```bash
just dist
```

产物：

| 路径 | 说明 |
|---|---|
| `release/win-unpacked/` | 免安装的散装目录（`飞船.exe` 直接双击也能跑，给自己调试用） |
| `release/airship-Setup-<版本>-x64.exe` | 安装包，**分发只发这一个文件** |
| `release/airship-Setup-<版本>-x64.exe.sha256` | 同内容的 SHA256，发给客户防止下载/传输被改动 |
| `release/*.blockmap` / `latest.yml` | 增量更新用的旁文件，现在用不上，留着不碍事 |

## 命令速查

| 命令 | 做什么 |
|---|---|
| `just dist` | 先清场，再构建三个目标 + 出安装包 + 自检（`.sha256` 由自检写）。唯一的发布入口 |
| `just verify-installer` | 出包后自检：安装包在不在、是不是 NSIS 向导、体积、写 `.sha256` |
| `just icon` | 由母版 `assets/icon-master.png` 重出 `assets/icon.ico`（16/24/32/48/64/128/256） |
| `just shot` | 逐窗口截图，验证"真的跑起来了"（安装包出之前至少跑一遍） |

> 清场（`code/clean-installer.mjs`）为什么算必要步骤：安装包的名字只由 `package.json` 的 version
> 决定，不 bump 版本号就永远是同一个文件名；一次没写成安装包的运行（`dist` 半路失败，或只跑了解包）
> 会让上一次那颗原地留着冒充刚出的那版。`verify-installer` 按名字匹配、只验 PE 头与 NSIS 签名，
> 对旧包照样全绿，还会把 `.sha256` 一起改成旧包的。规矩：**release/ 里的安装包永远等于最后一次构建，
> 宁可没有，不可有旧的**。清掉的这颗重跑一次 `dist` 就回来；`win-unpacked` 不在删除范围内。

## 里面装了什么

1. `electron-vite build` → `out/main` + `out/preload` + `out/renderer`（每个应用一个懒加载 chunk）。
2. `electron-builder --win nsis`：把 `out/**`、`package.json`、`assets/icon.png`、`assets/tray.png` 打进
   `app.asar`，连同 Electron 运行时与生产依赖一起落到 `release/`。
   `pdfjs-dist`、`foliate-js`、`@napi-rs/canvas` 被显式排除——渲染侧的东西 vite 已经打进产物里，
   node_modules 里那份只是构建期依赖，留着纯属占地方（排除后安装包 132 MB → 116 MB，
   真 PDF 与 EPUB 在打包版里照样渲染，见下面的验证）。
3. NSIS 向导：`只为我安装`（不需要管理员权限）、可选安装目录、开始菜单 + 桌面快捷方式、
   控制面板里的卸载项；卸载**不动**用户数据（`%APPDATA%/airship` 里是书架与设置）。
   向导语言按系统界面语言自动选中简中或英文。

## 版本号

只有 `package.json` 里的 `"version"` 一处：它同时决定 exe 的文件版本、卸载项显示与安装包文件名
（`airship-Setup-<版本>-x64.exe`）。

## 已验证到哪一步

- `just dist` 出包 + `just verify-installer` 自检通过（MZ 头、NSIS 签名、SHA256）。
- **打包版真跑过**：直接执行 `release/win-unpacked/飞船.exe --shot`，七个窗口（启动器 + 六个应用）
  都开出来并截到图；再带 `AIRSHIP_AUTOTEST` 导入一份真 PDF，页面渲染正常 —— 说明排除构建期依赖没排除错。
- 打包版与开发版共用 `%APPDATA%/airship`，装上去书架是同一份。

## 没做的事（实话）

集中在 [todo.md](todo.md)：TD-002 阶段 C（改一个应用也要重出整个安装包）、TD-003 没有代码签名、
TD-004 没有自动更新链路、TD-005 想要 Inno Setup 那一档观感要先装 Inno 6。

对拿到安装包的人来说只有一条要预告：**没有签名，第一次运行会被 SmartScreen 拦一道"未知发布者"**，
点"仍要运行"就过去了。

## 客户机要求

- Windows 10 起（Electron 45 的下限），实际建议 Windows 11；
- 只有容器台还有额外要求：本机要有 `C:\Program Files\WSL\wslc.exe`（WSL 3 自带）。
  没有也能装能跑，容器台会读得到"这台机器上没有 wslc"，其余应用不受影响。
