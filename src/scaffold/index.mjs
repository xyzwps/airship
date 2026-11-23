#!/usr/bin/env node
/**
 * create-airship-app —— airship 应用项目的手脚架。
 *
 *   npx create-airship-app my-todo --template todo
 *
 * 它只做一件事：把模板复制成一个**仓库外的普通项目**，把 __APP_ID__ / __APP_NAME__ 两处
 * 占位换成真名。装依赖、起窗口都是后面的事，它会打出来。
 *
 * 模板两种：
 *   minimal  只有前端：一扇窗口、一个组件，不碰任何能力（capabilities 写空数组）；
 *   todo     前端 + 随包自带的后端程序：数据由后端写进 AIRSHIP_DATA_DIR 下的 todos.json。
 *
 * id 的形状这里判一次只是为了**早失败**——判据就是 @airship/contract 的 APP_ID_PATTERN 那一条，
 * 手脚架直接引它（npx 会连这条小依赖一起装，契约层不引任何东西，也就几 KB）。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID_PATTERN } from '@airship/contract'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const TEMPLATES = join(HERE, 'templates')

const USAGE = `用法：npx create-airship-app <目录> [--template minimal|todo]

  目录名就是应用 id：小写字母开头，1~32 位小写字母、数字与连字符。
  --template minimal  纯前端的最小起点（默认）
  --template todo     前端 + 后端：数据落磁盘 JSON 的待办清单
  界面显示名写在 src/app.ts 的 name 里，起完项目自己改，中文随便。`

/** 文本占位替换只给文本文件做：icon.ico 那种二进制直接拷字节 */
const TEXT_EXT = new Set(['.json', '.md', '.ts', '.tsx', '.js', '.mjs', '.css', '.html', '.txt'])
function isTextFile(name) {
  if (name === '.gitignore') return true
  const dot = name.lastIndexOf('.')
  return dot >= 0 && TEXT_EXT.has(name.slice(dot))
}

function render(text, { id, name }) {
  return text.replaceAll('__APP_ID__', id).replaceAll('__APP_NAME__', name)
}

/** 递归落模板：文本文件换占位，二进制（icon.ico）直接拷字节 */
function copyTree(src, dest, vars) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const toName = entry.replaceAll('__APP_ID__', vars.id)
    const to = join(dest, toName)
    if (statSync(from).isDirectory()) {
      copyTree(from, to, vars)
    } else if (isTextFile(entry)) {
      writeFileSync(to, render(readFileSync(from, 'utf8'), vars), 'utf8')
    } else {
      cpSync(from, to)
    }
  }
}

function cli(argv) {
  const dir = argv[0]
  if (!dir || dir === '--help' || dir === '-h') {
    console.log(USAGE)
    return dir === undefined ? 1 : 0
  }
  const rest = argv.slice(1)
  let template = 'minimal'
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (arg === '--template') template = rest[++i]
    else throw new Error(`不认识的参数：${arg}\n${USAGE}`)
  }
  if (!['minimal', 'todo'].includes(template)) {
    throw new Error(`没有这种模板：${template}（现在只有 minimal 与 todo）\n${USAGE}`)
  }

  const target = resolve(process.cwd(), dir)
  const id = basename(target)
  if (!APP_ID_PATTERN.test(id)) {
    throw new Error(
      `目录名 "${id}" 当不了应用 id：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符。` +
        `界面显示名不限字符——起个合规的目录名，显示名到 src/app.ts 的 name 里改。`
    )
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`${target} 已经存在且不是空目录，手脚架不往里盖东西`)
  }

  const displayName = template === 'todo' ? '待办清单' : id
  copyTree(join(TEMPLATES, template), target, { id, name: displayName })

  console.log(`已建 ${template} 项目：${target}`)
  console.log(`
下一步（都在 ${basename(target)} 里跑）：
  npm install            装上 @airship/sdk、@airship/cli 与 react/vite
  npx airship dev        开发模式起窗——改 src 下的源码，窗口里刷新即见
  npx airship start      直跑构建好的产物，与装好后双击快捷方式同一条路
  npx airship pack       产 dist-apps/${id}.airship
  npx airship installer  产每用户安装器（这台机器要先有 NSIS：winget install nsis.nsis）

前提：这台机器装过 airship runtime（${'C:\\Program Files\\airship\\runtime'}），
或把 AIRSHIP_PATH 指到它所在的目录。`)
  return 0
}

const selfPath = fileURLToPath(import.meta.url)
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === selfPath
if (invokedDirectly) {
  try {
    process.exitCode = cli(process.argv.slice(2))
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    process.exitCode = 1
  }
}
