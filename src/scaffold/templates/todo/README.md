# __APP_NAME__

create-airship-app 的 todo 模板：前端 + 后端的完整一圈。

- 窗口（`src/App.tsx`）只管渲染与发调用；
- 随包自带的后端程序（`src/backend.ts`）由 runtime 起成**它自己的一份进程**，
  把数据写进磁盘上的 `todos.json`（位置在环境变量 `AIRSHIP_DATA_DIR` 指的那个目录，只有这个应用那族碰得到）；
- 两边唯一的通道是 `api.backend.invoke(method, payload)`：一次调用，一次回话。

```
npm install
npm run dev        # 开发模式起窗（后端也从装好的包起，改了 backend 要重跑本命令）
npm run start      # 直跑构建好的产物
npm run pack       # 产 dist-apps/__APP_ID__.airship
npm run installer  # 产每用户安装器（要先有 NSIS：winget install nsis.nsis）
```

三处要紧的地方：

- 应用 id 就是这份 `package.json` 的 `name`——命令行不传 id，四个动词都认它。
- 后端按约定走，不进清单：`src/backend.ts` 或 `src/backend.js` 有就有、没有就没有，
  产包流水把它编成包根那份 `backend.js`；两份都在是响亮错误，留一份。
- 后端启动后要**最先**发一条 `{ ready: true }`，runtime 才把调用喂给它；回话用 `{ seq, ok, value | error }`。
- `icon.ico` 是任务栏那颗外壳图标，**自备的**（缺了产包会响亮失败）。
