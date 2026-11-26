# create-airship-app

airship 应用项目的手脚架：一条命令落出一个能直接跑起来的普通项目。

```
npx create-airship-app my-todo                 # 最小起点：一扇窗口、一个组件，不碰任何能力
npx create-airship-app my-todo --template todo # 前端 + 随包自带的后端：数据落磁盘 JSON 的待办清单
```

目录名就是应用 id（小写字母开头，1~32 位小写字母、数字与连字符），同时写进项目根 `package.json` 的 `name`——之后 `npx airship` 的每条命令认的都是它，命令行不再传 id。

落下来的项目是常规形状：

```
my-todo/
  package.json
  src/
    app.ts      纯数据清单（id / name / description / capabilities）
    App.tsx     组件本体，宿主把 api 当 prop 递进来
    app.css     版心：配色只用宿主给的 CSS 变量
    index.html  入口文档
    main.tsx    一行 createAirshipApp({ meta, component, icon })
    icon.png    包根那张源图（只认 png）
    icon.ico    外壳图标（发版前换成你自己的多尺寸 .ico）
    backend.ts  仅 todo 模板：随包自带的后端程序（约定：有这文件就有后台，产包编成包根 backend.js）
```

起完项目三步走：`npm install` → `npm run dev`（热更起窗）→ `npm run pack`（产包）。`dev` / `start` / `pack` / `installer` 四个动词都已包在项目的 `scripts` 里。
