// 从 @iconify-json/lucide 裁出 S3 用到的那十几颗图标，生成 src/apps/airship-s3/icons.ts。
//
// 为什么不整集 import：@iconify-json 一份 icons.json 两千多个图形（几百 KB），
// 打进包就是每窗口的常驻内存；用到的只有十几颗，裁出来落成一个源码文件，
// 运行期只剩 addCollection 登记 + <Icon> 查表，不碰网络（api.iconify.design 那条默认路被绕开）。
//
// 用法：改下面 ICONS 的名单（注释写着每颗挂在谁身上），跑 `node code/gen-s3-icons.mjs` 重出。
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 名字 → 落点。lucide 没有桶的图形，桶用 archive（箱子）；trash-2 是别名，解析到底下的 trash */
const ICONS = {
  settings: '顶栏「连接设置」',
  'refresh-cw': '顶栏「刷新」',
  upload: '面包屑「上传」',
  archive: '顶栏「新建桶」',
  'folder-plus': '面包屑「新建目录」',
  'chevron-left': '页脚「上一页」',
  'chevron-right': '页脚「下一页」',
  'chevron-down': '源键上的小箭头',
  plus: '源列最后一行「添加源」前面那颗',
  download: '行键「下载」',
  link: '行键「复制临时链接」',
  'pen-line': '行键「重命名」',
  'trash-2': '行键「删掉」「删掉目录」与卡里「删掉这个源」',
  check: '提交类：「连上」「存下」「建」「改」',
  x: '收掉类：「取消」「收起」'
}

const data = readLucide()

/** 图标可能落在 icons 里，也可能是 aliases 里指向别名的别名——一路跟到底，跟不到就响亮报错 */
function resolve(name) {
  if (data.icons[name]) return data.icons[name]
  const alias = (data.aliases ?? {})[name]
  if (alias) return resolve(alias.parent)
  throw new Error(`lucide 集合里没有「${name}」——换名字或去集合里核实后再列`)
}

function readLucide() {
  for (const dir of [path.join(root, 'node_modules'), path.join(root, 'src/apps/airship-s3/node_modules')]) {
    try {
      return require(path.join(dir, '@iconify-json/lucide/icons.json'))
    } catch {
      // 换下一个落点再试
    }
  }
  throw new Error('找不到 @iconify-json/lucide——先 `npm install`（它是 @airship/airship-s3 的 devDependency）')
}

const picked = {}
for (const name of Object.keys(ICONS)) {
  const icon = resolve(name)
  picked[name] = icon
  console.log(`${name.padEnd(18)} ${Object.keys(ICONS).length} 颗之一，body ${icon.body.length} 字节`)
}

// lucide 全是 24×24；IconifyJSON 不写宽高时按 16×16 默认，viewBox 会错，所以必须钉上
const out = `// 这一份由 code/gen-s3-icons.mjs 生成，别手改——换图标或添图标去改那份名单，
// 再跑 \`node code/gen-s3-icons.mjs\` 重出。只裁用到的这十几颗：整套 lucide 不该进窗口。
import { addCollection, type IconifyJSON } from '@iconify/react'

/** 名字与落点的对照（生成时抄下来的）：
${Object.entries(ICONS)
  .map(([name, where]) => ` *  - ${name}: ${where}`)
  .join('\n')}
 */
export const S3_ICONS: IconifyJSON = {
  prefix: 'lucide',
  width: 24,
  height: 24,
  icons: ${JSON.stringify(picked, null, 2).replace(/\n/g, '\n  ')}
}

addCollection(S3_ICONS)
`

const dest = path.join(root, 'src/apps/airship-s3/icons.ts')
writeFileSync(dest, out, 'utf8')
console.log(`已写 ${path.relative(root, dest)}（${Object.keys(picked).length} 颗，${out.length} 字节）`)
