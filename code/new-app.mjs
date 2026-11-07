import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 从范本造一个新应用：`node code/new-app.mjs <id> [显示名]`
 *
 * 做的事只有复制与替换，不做任何"帮你决定"的事：
 * id 的形状由 `@airship/contract` 的 APP_ID_PATTERN 判（不合就拒，别写第二份判据），
 * 目录名、清单 id、包名三处必须一致，所以这里一次替换到位。
 *
 * 造完还要跑两件事才看得见效果：`npm install`（workspaces 要重新链）与 `just build-apps`（产包）。
 */

const ROOT = resolve(import.meta.dirname, '..')
const TEMPLATE = join(ROOT, 'templates', 'app')

const [id, displayName] = process.argv.slice(2)
if (!id) {
  console.error('用法：node code/new-app.mjs <id> [显示名]　例如：node code/new-app.mjs hello 你好')
  process.exitCode = 1
  process.exit(1)
}

const dest = join(ROOT, 'src', 'apps', id)
if (existsSync(dest)) {
  console.error(`src/apps/${id} 已经存在——换 id 或先把它删掉`)
  process.exit(1)
}

// 名字用契约层那一条正则判，不在这里另立一套
const pattern = readFileSync(join(ROOT, 'src', 'shared', 'contract', 'app.ts'), 'utf8').match(
  /export const APP_ID_PATTERN = (\/[^\n]+\/)/
)?.[1]
const APP_ID_PATTERN = pattern ? new RegExp(pattern.slice(1, -2)) : /^[a-z][a-z0-9-]{0,31}$/
if (!APP_ID_PATTERN.test(id)) {
  console.error(`id "${id}" 不合形状：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符`)
  process.exit(1)
}

const name = displayName ?? id

/** 范本里所有 CHANGE_ME 都是给人替换的：文件名与文件内容一起换 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from)) {
    const src = join(from, entry)
    const dstName = entry.replace(/CHANGE_ME/g, id)
    const dst = join(to, dstName)
    if (statSync(src).isDirectory()) {
      copyTree(src, dst)
      continue
    }
    const text = readFileSync(src, 'utf8').replace(/CHANGE_ME/g, entry.endsWith('.md') ? id : id).replace(/显示名/g, name)
    writeFileSync(dst, text, 'utf8')
  }
}

copyTree(TEMPLATE, dest)

console.log(`已造 src/apps/${id}`)
console.log(`  显示名：${name}`)
console.log(`  下一步：npm install && just build-apps && just shot`)
console.log(`  要改的三处：app.ts（能力与尺寸）、${id}.css（版心）、specs/${id}.md（契约）`)
rmSync(join(dest, 'CHANGE_ME.css'), { force: true })
