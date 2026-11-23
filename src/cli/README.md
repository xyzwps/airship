# @airship/cli

airship 应用作者的命令行：产包、开发模式起窗、直跑产物、每用户安装器。

四个动词，对应一个应用从源码到别人桌面的四步。**都不带 id 参数**——一个项目一个应用，id 就是项目根 `package.json` 的 `name`，命令行再传一遍等于给它第二个真源。

## 用法

四个动词都在**应用项目根目录**跑。`npx create-airship-app` 建出来的项目已把它们包进 `package.json` 的 `scripts`，日常就是：

```
npm run pack        构建并装成 dist-apps/<id>.airship
npm run dev         开发模式起窗：源码走 dev server 热更，Ctrl-C 收摊
npm run start       直跑构建好的产物——与双击快捷方式同一条路
npm run installer   把包裹成每用户安装器 exe（这台机器要先有 NSIS）
```

直调 `npx airship <动词>` 也完全同形——scripts 只是同一批命令的别名。

选项：

```
--packages <目录>  包的落点/取处，默认 dist-apps
--out <目录>       安装器落点，默认 release/apps
--port <端口>      dev server 端口，默认 5177
--version <版本>   安装器版本；不写就读项目根 package.json 的 version
--publisher <名>   卸载项里的发布者，默认 airship
--makensis <路径>  指到 makensis.exe；也可用环境变量 AIRSHIP_MAKENSIS 或让它进 PATH
```

runtime 不用你操心从哪来：命令自己按 `AIRSHIP_PATH` > `C:\Program Files\airship\runtime` 去找，找不到会把话说到脸上。
