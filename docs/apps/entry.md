# 应用入口

一个应用 = **一份自持的文档**（渲染进程）+ **一条桥**（runtime 主进程）+ **可选一个随包后台进程**（Node 侧）。
应用不许 import `src/runtime/**`：窗口能碰到的东西全在 `@airship/contract` 与 SDK 那两面——包才装得进别人的 runtime。

## 入口有哪几件

| 文件 | 角色 | 产包后 |
| --- | --- | --- |
| `app.ts` | 纯数据清单 `app: AppMeta` | 包根 `manifest.json`（补 `schemaVersion` / `sdkVersion` / `entry`） |
| `index.html` | 只有 `<div id="root">` 与 `./main.tsx` | 包根 `index.html`，即 `airship://<id>/index.html` |
| `main.tsx` | 一行 `createAirshipApp({ meta, component, icon })` | 构建进 bundle |
| `icon.png` / `icon.ico` | 文件名靠约定 | 见 [icon.md](icon.md) |
| `backend.ts` | 可选：随包后台 | bundle 成包根 `backend.js` |

入口 html 不写 CSP（`src/sdk/cspPlugin.ts` 构建时注入，自己写一条直接报错），引用一律相对路径——dev 时文档在 `/apps/<id>/` 下，产包后在 `airship://<id>/` 下。

## 宿主件在 SDK

`createAirshipApp` 把 `src/sdk/host.tsx` 的宿主装进 `#root`：标题栏、主题落地、`flush` 那一档留白、加载占位，每个应用都一样，作者不必自己画。**runtime 不往应用窗口注入任何 DOM。**

## 开窗

窗口加载 `airship://<id>/<entry>`，由 `packageProtocol.ts` 从归档里现读那一个条目，`cache-control: no-store`（装包是整档替换，改了包立刻生效）。

dev 只差一处：`loadPackageEntry` 优先吃 `AIRSHIP_DEV_URL`，文档走 vite 热更，注入的身份两边一样。再启动一次同一个 runtime，argv 转给已在跑的那份，由它按同 id 聚焦窗口。

## 桥：runtime 主进程（多个应用共用一份）

渲染侧唯一的对外面孔是 preload 注入的 `window.airship`。清单里没声明的能力位一律拒；失败回的是中文原话，不是 Electron 内部措辞；事件只投归属窗口，应用没开就丢弃、不广播。

fs 除能力位外还要过一层路径表：自己数据目录内天然可读写，目录外的只能来自本次会话里用户经系统对话框显式选中的路径。

## 随包后台

要连外部服务、流式读写大文件、跑长任务的应用自带一份 Node 进程（现成两份：S3 与 airship-dago）。

- 有没有它看**包形状**：归档根有 `backend.js` 才有。源项目应用目录里的 `backend.ts` / `backend.js` 有且只有一处，产包时 bundle 成那一份。
- 起进程前落到 `<userData>/apps/<id>/backend/backend.cjs`——`.cjs` 让扩展名自带 CommonJS 声明，不受外层 `"type": "module"` 影响。
- 写这个文件要守的对话形状：runtime 发 `{ seq, method, payload }`；后端启动后**第一件事**回 `{ ready: true }`，之后每条回 `{ seq, ok, value | error }`，主动推走 `{ event: true, method, payload }`。等就绪 10 秒，单次回话 30 秒。
- 生命周期跟着窗口：开窗预热（起不来只进日志）、关窗收掉；它崩了不拖累窗口，下一次 invoke 再拉起新的。
- 交给它的位置只有 env 三件套 `AIRSHIP_APP_ID` / `AIRSHIP_DATA_DIR` / `AIRSHIP_CACHE_DIR`，数据只该落在这两个目录里。

## 窗口不直连网络

产包档 CSP 是 `connect-src 'self' ipc:`——窗口既发不出外连也不碰盘，要连外部服务只能交给随包后台（Node 侧不受同源策略与 CSP 管）。窗口拿到的只有路径字符串：拖放事件里的字节是样子货，真路径只能由 preload 的 `webUtils.getPathForFile(file)` 换出来。
