# airship · 给代理的说明

飞船是一个 Electron 壳，里面装着六个自用应用（墨读 · 打勾勾 · 生命游戏 · PDF · vcp · 容器台）。
一个应用一个窗口一个渲染进程。这里只写"不照做就会做错"的事；架构理由见
[docs/architecture.md](docs/architecture.md)，用户可见契约见 [docs/specs/index.md](docs/specs/index.md)。

## 动手之前

1. **命令只走 justfile**。`package.json` 里没有 `scripts`，别再往回加；`just` 不带参数就列出全部配方。
2. **待办只看 [docs/todo.md](docs/todo.md)**，别处不留零碎待办。**没人做过决定时，不要擅自记录任何 todo。**
3. **改之前先读对应的规格册**（`src/<区>/<名>/specs/*.md`）。册子是契约，用例是它的影子，不是反过来。
4. 工作树里可能有**使用者自己正在改的东西**。不是你这轮改的文件别动；发现冲突先说清"发布物是否已包含它"再让他挑。

## 命令

```
just dev            开发            just build          构建三个目标
just test           单测            just casecov        册子编号与用例编号的双向差集
just typecheck      两个 tsconfig   just check          提交前一轮（类型 + 单测 + 差集）
just shot           逐窗口截图      just icon           由母版重出壳的 icon.ico
just dist           出安装包        just verify-installer  出包自检
just e2e / just wsld-real           要真环境的那两档（ffmpeg / wslc）
```

## 加一个应用 = 加一个目录

`src/apps/<id>/` 三份文件，缺一件在注册期炸：`app.ts`（纯数据清单）、`index.tsx`（默认导出组件）、
`icon.svg|png|jpg|jpeg|webp`（**有且只有一张**，不套底板，颜色烘进图里）。
**壳侧任何文件都不用改**——`src/apps/index.ts` 靠 glob 发现，主进程与渲染侧读同一批清单。
这条有用例守着（AP-010：壳里不许出现具体应用 id 的字面量）。

清单只写"这个应用自己的事实"：`id / name / description / capabilities / platforms / tools / flush /
defaultWidth / defaultHeight`。**不写** `iconPath`、`order` 这类表现或关系字段（都被驳回过）。
`capabilities` 是唯一授权面，没声明的一律拒绝；用不到就写 `[]`（生命游戏就是这么起的）。
用了 `api.settings.` / `api.proc.` 这些域就必须声明对应能力，AP-011 会扫。

## 规格册

四档结构（Purpose → Requirement → Scenario → WHEN/THEN），每条 Scenario 带稳定编号（`BK-032` 这种），
**只写可观察结果**：界面读得到哪句话、错误文案原文、交给外部 CLI 的命令行、落盘文件的形状。
不写实现——不出现类名、方法名、控件名。一条 Scenario ≤ 5 行，只锁一个不变量。

- 编号是稳定句柄：不复用、不重排；删除是显式动作，要说清这条契约为什么不再成立。
- 用例标题以编号开头，`just casecov` 做双向差集：册里有号没用例 = 未实现，用例挂了号册里没有 = 私测（禁止）。
- **界面观感（宽度、圆角、对齐、真排版好不好看）不进册子**，那是 `just shot` 截图走查的事，截图产物不入代码库。
- 写不出可执行判据的期望别进册子，记到 architecture.md 对应小节。

## 墨读支持的格式

**只有 EPUB 与 MOBI。** 唯一真源是 `src/shared/library/index.ts` 的 `BookFormat`
（`'epub' | 'mobi' | 'pdf'`，pdf 是 PDF 应用那侧的位）。TXT 与 azw3 都在 2026-11-06 被退回，
别把文件选择框里的扩展名别名当契约——要加格式是一次契约变更：改类型 + 开册子场景 + 造样本。

## 出包

`just dist` = 清场 → 构建 → NSIS → 自检 + 写 `.sha256`，一条命令走完，**没有单独的"只解包"配方**。
安装包文件名只由 `package.json` 的 `version` 决定，所以出包入口必须先删旧包：
**宁可响亮报错没有，不许旧包冒充新包**（`code/clean-installer.mjs`）。
没有代码签名，第一次运行会被 SmartScreen 拦一道。

## 写用例的规矩

替身（`src/shell/tests/helpers/fakeAirship.ts`、`mount.tsx`）**只能实现真 API 面上存在的方法**。
教训有两条：替身窗口写过 `setAppUserModelId`（BrowserWindow 上根本没有这个方法），用例绿着而真机没生效；
`window.x?.()` 这种可选链会把"方法不存在"吞成静默空操作——缺什么要喊出来，别默默跳过。
jsdom 没有 2D canvas：画布类判据只断言文字、状态与几何数字，"真画出来了"归 `just shot`。

## 汇报口径

性能按**用户可感知的指标**报，并且要有实测数字（`just shot` 会打每窗口内存与首屏耗时）；
没解决就说没解决，别用"符合设计"辩护。外部引用（法条、标准、格式规范、他人库的行为）先查原文再断言——
连"凭记忆的形状与常数"也一样，先穷举 + 实测再写进数据里。

## 本机事实

- Shell 是 Git Bash + PowerShell 5.1，控制台默认 **GBK**：Python 脚本里打印 `✓` 或韩文会 `UnicodeEncodeError`，
  用 ASCII 或中文（GBK 能编码）；乱码输出不代表文件坏了。
- Electron 与 electron-builder 的二进制走 npmmirror：`.npmrc` 里配了 `electron_mirror` 与
  `electron_builder_binaries_mirror`，`just dist` 里也显式带上同名环境变量。
- Pillow 不认 SVG，无头 Chrome 截内联 SVG 会出空白；要 SVG→位图用 `@resvg/resvg-js`（需要时重装即可）。
- 系统级动作（重启 explorer、清图标缓存、覆盖安装）**只给命令，由使用者执行**，别自己跑。
- 工具脚本一律放 `code/`（现成有 `make-ico.py`、`make-icons.py`、`make-jingang-epub.py`、`make-mobi.py`、
  `clean-installer.mjs`、`verify-installer.mjs`）；中间产物写到系统临时目录，别落在仓库里。
  `out/`、`release/`、`shots/` 都不入库，根目录保持干净。

## 沟通

全中文。只答被问的那件事，别顺带交付额外的文书、全景或多方案矩阵；延伸只留一句提问。
**提交由使用者发起**——改完停在"未提交"，除非他明说提交。
