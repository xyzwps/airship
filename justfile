# 飞船（airship）构建入口 —— 这个仓库里命令的唯一真源
#
# package.json 不再有 scripts：顺序、前置条件、环境变量这些只在这里写一次。
# 每个配方体都是能直接照抄去跑的一条命令，没有别名套别名。
#
# 用法：
#   just                列出全部配方
#   just dev            开发模式
#   just dist           出安装包（清场 → 构建 → NSIS → 自检 + 写 .sha256）
#   just check          提交前一轮：类型 + 单测 + 册子差集
#
# 关键的两条不变式，都靠配方依赖钉住，不靠人记得住：
#   1. dist 以 clean-release 开头 —— 出包前必清场，上一次那颗不可能活着躺在 release/ 里冒充新包；
#   2. dist 以 verify-installer 收尾 —— 出包和出包自检是同一条命令，没有"忘了自检"这条路。

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

# 开发模式：起 electron-vite dev
dev:
    {{vite}} dev

# 构建三个目标：out/main + out/preload + out/renderer
build:
    {{vite}} build

# 跑构建好的产物（不重启 dev server）
start:
    {{vite}} preview

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

# 逐窗口截图（先构建，截图吃的是产物）
shot: build
    AIRSHIP_SHOT=1 {{bin}}/electron . --shot

# 由母版 assets/icon-master.png 重出 assets/icon.ico
icon:
    python code/make-ico.py

# 清掉 release/ 里上一次留下的安装包（宁可没有，不可有旧的）
clean-release:
    node code/clean-installer.mjs

# 出安装包并自检：清场 → 构建 → NSIS → 验包 + 写 .sha256。唯一的发布入口；win-unpacked/ 是这一步就地解包的产物，不用另开命令。
dist: clean-release build
    ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
    ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
    {{builder}} --win nsis
    node code/verify-installer.mjs

# 单独跑一次出包自检（安装包已存在时）
verify-installer:
    node code/verify-installer.mjs

# 真编码那一路：要本机 ffmpeg 与真素材
e2e:
    VCP_E2E=1 {{vitest}} run e2e

# 真 wslc 只读命令那一路：要本机有 wslc
wsld-real:
    AIRSHIP_WSLD_INTEGRATION=1 {{vitest}} run src/apps/wsld/tests/real.test.ts
