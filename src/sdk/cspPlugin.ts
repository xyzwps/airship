import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pickCsp } from './csp.ts'

/**
 * 往**应用入口 html** 里注入 CSP 的 vite 插件。
 *
 * CSP 不由各应用自己抄写：一条权限字符串在六个应用里各抄一遍，
 * 就会有第六个版本悄悄少一个 `worker-src`。写在一处、构建时注入，
 * 产包后每个包的 `index.html` 里确实带着这一条（包自持），但源头只有一份。
 *
 * 只管 `src/apps/<id>/index.html`：启动器是壳自己的文档，它的 CSP 手写在
 * `launcher.html` 里，不经过这里。dev 注入带 localhost 的那条（react-refresh 要一段
 * 内联脚本，`script-src 'self'` 会把它挡掉），产包注入收紧的那条。
 * 判据是 ctx 里有没有 bundle：build 才有 bundle，dev 没有。
 * 清单里声明了 `net` 的应用换放宽 `connect-src` 的那一档——选哪一条的逻辑在 `csp.ts` 的 `pickCsp`。
 */

/**
 * 这个应用声明了哪些能力：从入口 html 旁边的 `app.ts` 里读那一份数组。
 *
 * 为什么不问构建器：dev 那一侧是一个 vite 服务同时供所有应用文档，
 * 一个进程级的环境变量给不出"每个应用各自的能力"，而插件唯一稳定拿得到的就是文件名。
 * 于是这里独立解一遍 `app.ts`，产包器那边另有一份（`code/build-apps.mjs` 把整份清单转出来）——
 * 两份的一致性由 `src/sdk/tests/csp.test.ts` 逐个应用比对钉住，与包格式那两份判据同一个做法。
 */
function capabilitiesOf(htmlFile: string): string[] {
  const source = join(dirname(htmlFile), 'app.ts')
  if (!existsSync(source)) return []
  const text = readFileSync(source, 'utf8')
  const block = /capabilities:\s*\[([^\]]*)\]/.exec(text)
  const body = block?.[1] ?? ''
  return [...body.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '').filter((s) => s !== '')
}

export function airshipCspPlugin(): {
  name: 'airship-csp'
  transformIndexHtml: (html: string, ctx: { filename?: string; bundle?: unknown }) => string
} {
  return {
    name: 'airship-csp',
    transformIndexHtml(html, ctx) {
      const file = ctx.filename ?? ''
      if (!/[\\/]apps[\\/]/.test(file)) return html
      if (/http-equiv="Content-Security-Policy"/i.test(html)) {
        throw new Error(
          `${file}：入口 html 里不许自己写 CSP——那一条由 src/sdk/csp.ts 在构建时注入（六个应用各抄一遍迟早抄出第五个版本）`
        )
      }
      const csp = pickCsp({ bundle: Boolean(ctx.bundle), net: capabilitiesOf(file).includes('net') })
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
      const injected = html.replace(/(<head[^>]*>)/i, `$1\n    ${meta}`)
      if (injected === html) throw new Error(`${file}：入口 html 里没有 <head>，CSP 注不进去`)
      return injected
    }
  }
}
