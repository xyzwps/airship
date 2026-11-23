#!/usr/bin/env node
/**
 * `airship` —— airship 应用作者的命令行（外部项目视角）。
 *
 * 四个动词，对应用从源码到别人桌面的四步，**都不带 id 参数**——一个项目一个应用，
 * id 就是项目 package.json 的 name，命令行再传一遍等于给它第二个真源：
 *
 *   airship pack        构建 + 装成 dist-apps/<id>.airship
 *   airship dev         开发模式起窗：dev server 源码热更，包只供注册（Ctrl-C 收摊）
 *   airship start       直跑构建好的产物——与双击快捷方式同一条路
 *   airship installer   把包裹成每用户安装器（要装 NSIS，见 --makensis）
 *
 * 都在项目根目录跑（用 cwd 找 src/ 或根下的应用文件）。
 * 判据与流水全部住在 lib/ 那几份模块里，仓库内的 just 配方跑的是同一批代码。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGE_SUFFIX, APP_ID_PATTERN } from '@airship/contract'
import { buildAndPack, runDev, runStart } from '../lib/app-pipeline.mjs'
import { buildInstaller, findMakensis } from '../lib/installer.mjs'

const USAGE = `airship —— airship 应用作者的命令行（在项目根目录跑）

  airship pack        构建并装成 dist-apps/<id>.airship（--packages 换落点）
  airship dev         开发模式起窗：源码热更，Ctrl-C 收摊（--port 换 dev server 端口）
  airship start       构建后直跑产物，与双击快捷方式同一条路
  airship installer   把包裹成每用户安装器 exe（要装 NSIS：makensis）

id 不写在命令行上：它就是项目 package.json 的 name。

选项：
  --packages <目录>  包的落点/取处，默认 dist-apps
  --out <目录>       安装器落点，默认 release/apps
  --port <端口>      dev server 端口，默认 5177
  --version <版本>   安装器版本；不写就读项目根 package.json 的 version
  --publisher <名>   卸载项里的发布者，默认 airship
  --makensis <路径>  指到 makensis.exe；也可用环境变量 AIRSHIP_MAKENSIS 或让它进 PATH`

/** 极简参数表：动词 + `--键 值`；位置参数一律拒——id 的真源是 package.json 的 name */
function parseArgv(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      throw new Error(`airship ${command} 不接 id：id 念的是项目 package.json 的 name，把 "${arg}" 去掉就行`)
    }
    const key = arg.slice(2)
    const value = rest[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} 后面要跟一个值`)
    flags[key] = value
    i += 1
  }
  return { command, flags }
}

/** id 的真源：项目根 package.json 的 name。一个项目一个应用，命令行不再传第二遍 */
function readProjectId(projectRoot) {
  const pkgFile = join(projectRoot, 'package.json')
  if (!existsSync(pkgFile)) {
    throw new Error(`没有 ${pkgFile}：airship 命令要在应用项目的根目录跑`)
  }
  const name = JSON.parse(readFileSync(pkgFile, 'utf8')).name
  if (typeof name !== 'string' || name === '') {
    throw new Error(`${pkgFile} 里没有 name：应用 id 念的就是它`)
  }
  if (!APP_ID_PATTERN.test(name)) {
    throw new Error(
      `package.json 的 name "${name}" 当不了应用 id：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符`
    )
  }
  return name
}

/** 安装器的版本号：--version > 项目根 package.json 的 version */
function installerVersion({ projectRoot, flags }) {
  if (flags.version) return flags.version
  const v = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')).version
  if (typeof v === 'string' && v !== '') return v
  throw new Error(`没有版本号：给 --version，或在项目根 package.json 里写 version`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') {
    console.log(USAGE)
    return
  }
  const { command, flags } = parseArgv(argv)
  const projectRoot = process.cwd()
  const packagesOut = flags.packages ?? 'dist-apps'

  if (!['pack', 'dev', 'start', 'installer'].includes(command)) {
    throw new Error(`不认识的命令：${command}（看 airship --help）`)
  }
  const id = readProjectId(projectRoot)

  if (command === 'pack') {
    const { file } = await buildAndPack({ projectRoot, id, packagesOut })
    console.log(`已产包 ${file}`)
    return
  }
  if (command === 'dev') {
    await runDev({ projectRoot, id, port: Number(flags.port ?? 5177), packagesOut })
    return
  }
  if (command === 'start') {
    process.exitCode = await runStart({ projectRoot, id, packagesOut })
    return
  }

  // installer：吃已产好的包；id 与版本都从项目根 package.json 来
  const archivePath = resolve(projectRoot, packagesOut, `${id}${PACKAGE_SUFFIX}`)
  if (!existsSync(archivePath)) {
    throw new Error(`没有 ${archivePath}：先跑 airship pack`)
  }
  const makensis = findMakensis({ flag: flags.makensis })
  const { file } = buildInstaller({
    archivePath,
    version: installerVersion({ projectRoot, flags }),
    publisher: flags.publisher ?? 'airship',
    outDir: resolve(projectRoot, flags.out ?? 'release/apps'),
    makensis,
    log: (line) => console.log(line)
  })
  console.log(`安装器就绪：${file}（分发给别人前注意：第一次运行会被 SmartScreen 拦一道——没有代码签名）`)
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e))
  process.exitCode = 1
})
