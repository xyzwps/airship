# 飞船（airship）构建入口 —— 这个仓库里命令的唯一真源
#
# package.json 不再有 scripts：顺序、前置条件、环境变量这些只在这里写一次。
# 每个配方体都是能直接照抄去跑的一条命令，没有别名套别名。
#
# 用法：
#   just                列出全部配方
#   just dev <id>       开发模式：直跑那一个应用（文档热更，清单与图标走包）
#   just app-installer <id>  产那一个应用的安装器（release/apps/ 下的 setup.exe）
#   just build          两条都跑：打 runtime 的安装包 + 产各应用的 airship 包
#   just build-runtime  只打 runtime 的安装包
#   just build-apps     只产各应用的包
#   just check          提交前一轮：类型 + 单测 + 册子差集
#
# 关键的两条不变式，都靠配方依赖钉住，不靠人记得住：
#   1. build-runtime 以 clean-release 开头 —— 出包前必清场，上一次那颗不可能活着躺在 release/ 里冒充新包；
#   2. build-runtime 以 verify-installer 收尾 —— 出包和出包自检是同一条命令，没有"忘了自检"这条路。

# 显式指定 Git Bash：just 按 PATH 解析 "bash" 时命中的是 C:\WINDOWS\System32\bash.exe（WSL bash），
# 它跟本机工具链对不上。写死 Git 自带的那个，跟仓库里其它脚本同一个 shell。
set shell := ["C:/Program Files/Git/bin/bash.exe", "-cu"]

bin := "./node_modules/.bin"
builder := bin + "/electron-builder"
vite := bin + "/electron-vite"
vitest := bin + "/vitest"

default:
    @just --list

# 列出可用任务（和 default 同一条，给记不住 `just` 不带参数的人）
tasks:
    @just --list

# 产各应用的 airship 包到 dist-apps/：每应用一次独立构建，产物装成 <id>.airship（一个 zip 换了扩展名）
# 契约见 src/apps/specs/package.md
build-apps: clean-apps
    node code/build-apps.mjs

# 清掉 dist-apps/ 整个目录。
# 产包那条是逐个归档"写暂存名再改名"，自己不留垃圾；这条管的是另一种局面：
# 应用被删了、想彻底归零、或者只想让 runtime 看见重新产出来的那一批。
clean-apps:
    rm -rf dist-apps

# 开发模式：just dev life —— 直跑那一个应用。
# 先产包（runtime 注册的是命令行指来的那份归档，清单与图标从包里读），
# 再起 electron-vite dev：应用的文档走 dev server（改一行即热更）。
# 所以改了 app.ts 要重跑一次 just build-apps。
# `--` 之后的参数转给 electron 本体：那一份包路径就是 runtime 的 argv。
dev id: build-apps
    # electron-vite 的 dev 用 process.cwd() 找"runtime 的 package.json 的 main"当入口——
    # 必须在 src/runtime 里跑。包路径随之传绝对路径：electron 的 cwd 变了，相对 dist-apps 会指错地方。
    cd src/runtime && ../../node_modules/.bin/electron-vite dev --config electron.vite.dev.config.ts -- "{{justfile_directory()}}/dist-apps/{{id}}.airship"

# 编译 runtime 的两个目标 → src/runtime/out/{main,preload}（不出安装包）
# runtime 没有自己的文档：配置里没有 renderer 目标，产物里也不许有 out/renderer。
# 先清场再编：vite 只清它要写的那几个目标，旧时代留下的 out/renderer 不清就会一直躺着冒充产物。
compile:
    rm -rf src/runtime/out
    {{vite}} build src/runtime

# 跑构建好的产物（不起 dev server）：just start life —— 应用文档从包里加载（airship://），
# 这是与装好的 runtime 最接近的一条路，验"产物真能跑"用它
start id: compile build-apps
    {{bin}}/electron src/runtime "{{justfile_directory()}}/dist-apps/{{id}}.airship"

# 产一个应用的安装器：先产它那份包，再裹成每用户的 setup.exe（release/apps/<id>-Setup-<版本>.exe）。
# 契约见 src/apps/specs/package.md PK-031~035；makensis 用 electron-builder 缓存里那份。
app-installer id:
    node code/build-apps.mjs {{id}}
    node code/make-app-installer.mjs {{id}}

# 类型检查：node 侧与 web 侧两个 tsconfig
typecheck:
    {{bin}}/tsc --noEmit -p tsconfig.node.json
    {{bin}}/tsc --noEmit -p tsconfig.web.json

# 全部单测
test:
    {{vitest}} run

# 规格册编号与用例编号的双向差集
casecov:
    {{vitest}} run spec-coverage

# 提交前的一轮：类型 + 单测 + 册子差集
check: typecheck test casecov

# 逐窗口截图（先编译 runtime 与各家的包，截图吃的是产物）
# 这一条同时是包真能被 runtime 跑起来的端到端凭据：窗口加载的是 airship://<id>/index.html
# argv 一次指来全部包，截图工装逐个开窗口、按下快门、关掉再下一个
shot: compile build-apps
    AIRSHIP_SHOT=1 {{bin}}/electron src/runtime --shot dist-apps/*.airship

# 从范本造一个新应用：just new-app hello 你好
# 复制 templates/app → src/apps/<id>、换掉三处名字、重链 workspaces、只产这一个应用的包
new-app id *name:
    node code/new-app.mjs {{id}} {{name}}
    npm install
    node code/build-apps.mjs {{id}}

# 由母版重出 runtime 的 icon.ico
icon:
    python code/make-ico.py

# 清掉 release/ 里上一次留下的安装包（宁可没有，不可有旧的）
clean-release:
    node code/clean-installer.mjs

# 打 runtime 的安装包并自检：清场 → 编译 → NSIS → 验包 + 写 .sha256。
# 唯一的发布入口；win-unpacked/ 是这一步就地解包的产物，不用另开命令。
# 安装包是纯 runtime：不带任何 airship 包。应用包只落在 dist-apps/，由各应用自己的安装器装。
build-runtime: clean-release compile
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
    ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
    {{builder}} --projectDir src/runtime --win nsis
    node code/verify-installer.mjs

# 两条都跑：产各应用的包 + 打 runtime 的安装包。两者互不包含——安装包是纯 runtime，包只落在 dist-apps/。
build: build-apps build-runtime

# 单独跑一次出包自检（安装包已存在时）
verify-installer:
    node code/verify-installer.mjs

# 真编码那一路：要本机 ffmpeg 与真素材
e2e:
    VCP_E2E=1 {{vitest}} run e2e

# 真 wslc 只读命令那一路：要本机有 wslc
wsld-real:
    AIRSHIP_WSLD_INTEGRATION=1 {{vitest}} run src/apps/wsld/tests/real.test.ts