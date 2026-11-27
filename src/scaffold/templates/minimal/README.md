# __APP_NAME__

create-airship-app 的 minimal 模板：一扇 airship 窗口，带一份最小的随包后台——
计数住在 `src/backend.ts` 的内存里，点一下是一次请求-回话。不碰文件、不跑进程、不上网。

```
npm install
npm run dev        # 开发模式起窗，改 src 下的源码，窗口里刷新即见
npm run start      # 直跑构建好的产物
npm run pack       # 产 dist-apps/__APP_ID__.airship
npm run installer  # 产每用户安装器（要先有 NSIS：winget install nsis.nsis）
```

三处要紧的地方：

- 应用 id 就是这份 `package.json` 的 `name`——命令行不传 id，四个动词都认它。
- `src/app.ts` 是清单——应用对外形状的全部；id 不在里面，真源是这份 `package.json` 的 `name`。
- `src/icon.png` 是包根那张源图（**只认 png**，svg / jpg / webp 那批 2026-11-26 起退场）；`src/icon.ico` 是任务栏与快捷方式那颗外壳图标，**自备的**（缺了产包会响亮失败）。
- 窗口加载的文档、CSP 与标题栏都由 `@airship/sdk` 的宿主给，应用侧只有 `main.tsx` 那一行 `createAirshipApp`。
