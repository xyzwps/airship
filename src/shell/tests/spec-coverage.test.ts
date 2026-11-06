import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 规格册与用例的绑定检查（`just casecov`，对应 wslc-desktop 的 `just casecov`）。
 *
 * 册子与用例都**跟着它们管的代码走**：
 *
 *   src/shell/specs/shell.md   ↔  src/shell/tests/launcher.test.tsx
 *   src/apps/vcp/specs/vcp.md  ↔  src/apps/vcp/tests/*.test.ts
 *   src/shared/library/specs/… ↔  src/shared/library/tests/*.test.ts
 *
 * 所以这里不写死任何一个区的路径，递归找 `specs/*.md` 与 `*.test.ts(x)`。
 * 钉住三件事：
 *   1. 册里的编号一个都不能没有用例；
 *   2. 用例的编号一个都不能不在册里（私测禁止）；
 *   3. 册子本身的写法规矩（四档结构、编号升序、一条场景不超过五行、索引登记齐全）。
 *
 * 门控用例（要真环境才跑）标题里照样带编号，静态扫描就算它已实现——跑没跑由那档环境变量决定。
 */

const ROOT = join(__dirname, '..', '..', '..')
const SKIP = new Set(['node_modules', 'out', 'dist', 'shots', 'fixtures', '.git', '.tmp', 'bin', 'obj'])

interface Scenario {
  id: string
  title: string
  lines: number
  requirement: string
  missing: string[]
}

interface Book {
  /** 文件名去掉 .md */
  name: string
  /** 相对仓库根的路径，报错时说清是哪一本 */
  at: string
  prefix: string
  scenarios: Scenario[]
  problems: string[]
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) {
      if (SKIP.has(name)) continue
      walk(p, out)
    } else {
      out.push(p)
    }
  }
  return out
}

const allFiles = walk(ROOT)

/** 所有区的册子：路径里有一段叫 `specs` 的 .md（索引 index.md 除外） */
function findBooks(): Book[] {
  return allFiles
    .filter((p) => p.endsWith('.md') && basename(dirname(p)) === 'specs' && basename(p) !== 'index.md')
    .sort()
    .map((file) => {
      const text = readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/)
      const book: Book = {
        name: basename(file, '.md'),
        at: relative(ROOT, file).split(sep).join('/'),
        prefix: '',
        scenarios: [],
        problems: []
      }

      if (!lines[0]?.startsWith('# ')) book.problems.push('第一行必须是 `# <册子名>`')
      if (!lines.some((l) => l.startsWith('## Purpose'))) book.problems.push('缺 `## Purpose` 一节')

      let requirement = ''
      let collecting = false
      let body = 0
      let hasWhen = false
      let hasThen = false
      let pending: Scenario | null = null

      const flush = (): void => {
        if (!pending) return
        const missing: string[] = []
        if (!hasWhen) missing.push('WHEN')
        if (!hasThen) missing.push('THEN')
        if (missing.length) pending.missing = missing
        if (pending.lines > 5) book.problems.push(`${pending.id} 写了 ${pending.lines} 行，一条场景不许超过 5 行`)
        book.scenarios.push(pending)
        pending = null
        hasWhen = false
        hasThen = false
        body = 0
      }

      for (const raw of lines.slice(1)) {
        const line = raw.trimEnd()
        if (line.startsWith('### Requirement:')) {
          flush()
          requirement = line.replace('### Requirement:', '').trim()
          continue
        }
        const hit = /^#### Scenario:\s*([A-Z]{2,3}-\d{3})\s+(.*)$/.exec(line)
        if (hit) {
          flush()
          collecting = true
          const id = hit[1]!
          const prefix = id.split('-')[0]!
          if (!book.prefix) book.prefix = prefix
          else if (prefix !== book.prefix) book.problems.push(`${id} 的前缀与这本册子的 ${book.prefix} 不一致`)
          pending = { id, title: hit[2] ?? '', lines: 0, requirement, missing: [] }
          continue
        }
        if (!collecting) continue
        if (line.startsWith('## ') || line.startsWith('### ')) {
          flush()
          collecting = false
          continue
        }
        const t = line.trim()
        if (t === '') continue
        if (/^- \*\*(WHEN|THEN|AND)\*\*/.test(t)) {
          body += 1
          if (t.startsWith('- **WHEN**')) hasWhen = true
          if (t.startsWith('- **THEN**')) hasThen = true
          if (pending) pending.lines = body
        }
      }
      flush()

      if (!book.prefix) book.problems.push('一条 Scenario 都没有，这本册子是空的')
      return book
    })
}

/** 测试文件：路径里有一段叫 `tests`（或旧的 __tests__）的 *.test.ts(x) */
function findTestFiles(): string[] {
  return allFiles.filter(
    (p) =>
      /\.test\.tsx?$/.test(p) &&
      (basename(dirname(p)) === 'tests' || basename(dirname(p)) === '__tests__' || dirname(p).split(sep).includes('tests'))
  )
}

function boundIds(): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const file of findTestFiles()) {
    const text = readFileSync(file, 'utf8')
    // 只看 it/test 的第一个参数（标题字符串），注释里提编号不算绑定
    const titleRe = /(?:^|\s)(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
    for (let m = titleRe.exec(text); m !== null; m = titleRe.exec(text)) {
      for (const id of m[2]!.match(/\b[A-Z]{2,3}-\d{3}\b/g) ?? []) {
        const list = out.get(id) ?? []
        list.push(relative(ROOT, file).split(sep).join('/'))
        out.set(id, list)
      }
    }
  }
  return out
}

function indexRows(): Array<{ prefix: string; book: string }> {
  const file = join(ROOT, 'docs', 'specs', 'index.md')
  if (!existsSync(file)) return []
  const rows: Array<{ prefix: string; book: string }> = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\|\s*([A-Z]{2,3})\s*\|[^|]+\|\s*`([^`]+)\.md`\s*\|/.exec(line.trim())
    if (m) rows.push({ prefix: m[1]!, book: m[2]! })
  }
  return rows
}

const books = findBooks()
const bound = boundIds()

describe('规格册本身的规矩', () => {
  it('每本册子都写得像册子：标题、Purpose、四档结构、一条场景不超过五行', () => {
    const problems = books.flatMap((b) => b.problems.map((p) => `${b.at}：${p}`))
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('每条 Scenario 都有 WHEN 与 THEN', () => {
    const bad = books.flatMap((b) =>
      b.scenarios.filter((s) => s.missing.length > 0).map((s) => `${b.at} ${s.id} 缺 ${s.missing.join(' 与 ')}`)
    )
    expect(bad, bad.join('\n')).toEqual([])
  })

  it('同一 Requirement 内的编号按升序，全库编号不重复', () => {
    const seen = new Map<string, string>()
    const problems: string[] = []
    for (const book of books) {
      const byRequirement = new Map<string, string[]>()
      for (const s of book.scenarios) {
        const dup = seen.get(s.id)
        if (dup) problems.push(`${s.id} 在 ${dup} 和 ${book.at} 各出现一次`)
        seen.set(s.id, book.at)
        const list = byRequirement.get(s.requirement) ?? []
        list.push(s.id)
        byRequirement.set(s.requirement, list)
      }
      for (const [req, ids] of byRequirement) {
        const nums = ids.map((id) => Number(id.split('-')[1]))
        for (let i = 1; i < nums.length; i++) {
          if (nums[i]! <= nums[i - 1]!) problems.push(`${book.at}「${req}」里 ${ids[i]} 没有比 ${ids[i - 1]} 大`)
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('索引表登记的册子与实际存在的册子一一对应', () => {
    const rows = indexRows()
    const onDisk = books.map((b) => b.name).sort()
    const listed = rows.map((r) => r.book).sort()
    expect(onDisk.filter((n) => !listed.includes(n)), '磁盘上有但索引没登记').toEqual([])
    const notWritten = listed.filter((n) => !onDisk.includes(n))
    expect(notWritten, `索引登记了但还没有这本册子（还没写=未实现，别挂在索引里）：${notWritten.join(', ')}`).toEqual([])
    const mismatch = rows
      .map((r) => {
        const book = books.find((b) => b.name === r.book)
        return book && book.prefix && book.prefix !== r.prefix ? `索引写 ${r.prefix} → ${r.book}.md，册子里是 ${book.prefix}` : ''
      })
      .filter(Boolean)
    expect(mismatch, mismatch.join('\n')).toEqual([])
  })
})

describe('册子与用例的双向差集', () => {
  it('册里每一条 Scenario 都挂得上用例（没有未实现的契约）', () => {
    const unbound = books.flatMap((b) =>
      b.scenarios.filter((s) => !bound.has(s.id)).map((s) => `${b.at} ${s.id} ${s.title}`)
    )
    expect(unbound, `这些契约还没有用例：\n${unbound.join('\n')}`).toEqual([])
  })

  it('用例里出现的编号都在册子里（没有私测）', () => {
    const all = new Set(books.flatMap((b) => b.scenarios.map((s) => s.id)))
    const orphans = [...bound.keys()]
      .filter((id) => !all.has(id))
      .map((id) => `${id}（${bound.get(id)!.join(', ')}）`)
    expect(orphans, `这些编号在用例里但册子里没有：\n${orphans.join('\n')}`).toEqual([])
  })
})
