# __APP_NAME__

create-airship-app 的 todo 模板：前端 + 后端的完整一圈。

- 窗口（`src/App.tsx`）只管渲染与发调用；
- 随包自带的后端程序（`src/backend/index.js`）由 runtime 起成**它自己的一份进程**，
  把数据写进磁盘上的 `todos.json`（位置在环境变量 `AIRSHIP_DATA_DIR` 指的那个目录，只有这个应用那族碰得到）；
- 两边唯一的通道是 `api.backend.invoke(method, payload)`：一次调用，一次回话。

```
npm install
npx airship dev        # 开发模式起窗（后端也从装好的包起，改了 backend 要重跑本命令）
npx airship start      # 直跑构建好的产物
npx airship pack       # 产 dist-apps/__APP_ID__.airship
npx airship installer  # 产每用户安装器（要先有 NSIS：winget install nsis.nsis）
```

前提：这台机器装过 airship runtime（`C:\Program Files\airship\runtime`），
或把环境变量 `AIRSHIP_PATH` 指到 `airship.exe` 所在的目录。

三处要紧的地方：

- 应用 id 就是这份 `package.json` 的 `name`——命令行不传 id，四个动词都认它。
- `app.ts` 里 `capabilities: ['backend']` 与 `backend: 'backend/index.js'` 是一对——
  声明了能力就必须写入口，只写一边都会被拒（措辞在错误里念给你听）。
- 后端启动后要**最先**发一条 `{ ready: true }`，runtime 才把调用喂给它；回话用 `{ seq, ok, value | error }`。
- `icon.ico` 是任务栏那颗外壳图标，**自备的**（缺了产包会响亮失败）。
