import { AIRSHIP_CSP, AIRSHIP_CSP_DEV } from './csp.ts'

/**
 * 往**应用入口 html** 里注入 CSP 的 vite 插件。
 *
 * CSP 不由各应用自己抄写：一条权限字符串在六个应用里各抄一遍，
 * 就会有第六个版本悄悄少一个 `worker-src`。写在一处、构建时注入，
 * 产包后每个包的 `index.html` 里确实带着这一条（包自持），但源头只有一份。
 *
 * 只管 `src/apps/<id>/index.html`：启动器是壳自己的文档，它的 CSP 手写在
 * `launcher.html` 里，不经过这里。dev 注入 `AIRSHIP_CSP_DEV`（react-refresh 要一段
 * 内联脚本，`script-src 'self'` 会把它挡掉），产包注入收紧的 `AIRSHIP_CSP`。
 * 判据是 ctx 里有没有 bundle：build 才有 bundle，dev 没有。
 */
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
      const csp = ctx.bundle ? AIRSHIP_CSP : AIRSHIP_CSP_DEV
      const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`
      const injected = html.replace(/(<head[^>]*>)/i, `$1\n    ${meta}`)
      if (injected === html) throw new Error(`${file}：入口 html 里没有 <head>，CSP 注不进去`)
      return injected
    }
  }
}
