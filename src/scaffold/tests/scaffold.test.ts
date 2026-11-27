import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

/**
 * 手脚架产出来的必须是一个能直接 npm install 的项目骨架：
 * 占位换干净、目录按真 id 落、坏目录名响亮拒。真装真跑（要网络）归教程的实测，这里只判落盘形状。
 */

const REPO = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..')
const SCAFFOLD = join(REPO, 'src', 'scaffold', 'index.mjs')

function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCAFFOLD, ...args], { cwd, encoding: 'utf8' })
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

describe('create-airship-app', () => {
  it('todo 模板：常规形状 src/、占位全换、icon.ico 随模板就位', () => {
    const work = mkdtempSync(join(tmpdir(), 'airship-scaffold-'))
    const res = run(['my-todo', '--template', 'todo'], work)
    expect(res.status, res.stderr).toBe(0)

    const srcDir = join(work, 'my-todo', 'src')
    expect(existsSync(srcDir), '应用文件该落在 src/').toBe(true)
    const appTs = readFileSync(join(srcDir, 'app.ts'), 'utf8')
    expect(appTs, 'app.ts 不写 id：真源是根 package.json 的 name，产包注入 manifest.json').not.toMatch(/^\s*id:/m)
    expect(appTs).toContain("name: '待办清单'")
    expect(appTs, '清单不写它').not.toMatch(/capabilities/)
    expect(existsSync(join(srcDir, 'backend.ts')), '后端入口按约定平铺在 src/backend.ts').toBe(true)
    expect(existsSync(join(srcDir, 'backend')), '后端不再是目录').toBe(false)
    expect(statSync(join(srcDir, 'icon.ico')).size, '自备的外壳图标随模板在（PK-039）').toBeGreaterThan(1000)
    expect(existsSync(join(srcDir, 'icon.png')), '源图随模板在（PK-004 只认 icon.png）').toBe(true)
    expect(existsSync(join(srcDir, 'icon.svg')), '模板不留已退场的 svg 源图').toBe(false)

    // id 的真源：根 package.json 的 name 就是 id，版本也只有这一份
    const pkg = JSON.parse(readFileSync(join(work, 'my-todo', 'package.json'), 'utf8'))
    expect(pkg.name).toBe('my-todo')
    expect(typeof pkg.version).toBe('string')
    // 四个动词包进 scripts：作者跑的是 npm run，不是 npx
    expect(pkg.scripts).toMatchObject({ dev: 'airship dev', start: 'airship start', pack: 'airship pack', installer: 'airship installer' })
    expect(existsSync(join(srcDir, 'package.json')), 'src/ 下不该再有第二份 package.json').toBe(false)
    for (const file of walk(join(work, 'my-todo'))) {
      if (/\.(json|md|ts|tsx|js|css|html)$/.test(file)) {
        expect(readFileSync(file, 'utf8'), `${file} 里不许留占位`).not.toMatch(/__APP_(ID|NAME)__/)
      }
    }
  })

  it('minimal 模板：显示名落成 id（改不改归 src/app.ts 里用户自己），带一份最小后端', () => {
    const work = mkdtempSync(join(tmpdir(), 'airship-scaffold-'))
    const res = run(['ping'], work)
    expect(res.status, res.stderr).toBe(0)
    const appTs = readFileSync(join(work, 'ping', 'src', 'app.ts'), 'utf8')
    expect(appTs).toContain("name: 'ping'")
    expect(appTs, '清单不写它').not.toMatch(/capabilities/)
    expect(existsSync(join(work, 'ping', 'src', 'backend.ts')), 'minimal 也带后端——计数就在它内存里').toBe(true)
    expect(existsSync(join(work, 'ping', 'src', 'backend.js')), '后端入口只有一份 ts 源').toBe(false)
    expect(existsSync(join(work, 'ping', 'src', 'icon.png')), 'minimal 也带那张源图 icon.png').toBe(true)
    // 模板里那份叫 gitignore（npm pack 不收 .gitignore），落项目时必须改名就位
    const ignore = readFileSync(join(work, 'ping', '.gitignore'), 'utf8')
    const lines = new Set(ignore.split('\n').map((s) => s.trim().replace(/\/$/, '')))
    for (const entry of ['node_modules', 'dist-apps', 'release', '.airship-dev']) {
      expect(lines.has(entry), `.gitignore 该忽略 ${entry}`).toBe(true)
    }
  })

  it('目录名当不了 id 就拒并念规则；非空目录不往里盖', () => {
    const work = mkdtempSync(join(tmpdir(), 'airship-scaffold-'))
    const bad = run(['我的应用'], work)
    expect(bad.status).toBe(1)
    expect(bad.stderr).toContain('当不了应用 id')

    mkdirSync(join(work, 'taken'))
    writeFileSync(join(work, 'taken', 'note.txt'), '有东西', 'utf8')
    const taken = run(['taken'], work)
    expect(taken.status).toBe(1)
    expect(taken.stderr).toContain('不是空目录')

    const oldFlag = run(['x1', '--name', '某名'], work)
    expect(oldFlag.status, '显示名不再是命令行参数').toBe(1)
    expect(oldFlag.stderr).toContain('不认识的参数：--name')
  })
})
