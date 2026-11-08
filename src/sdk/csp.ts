/**
 * 应用包入口 html 的 CSP——**唯一的一份**。
 *
 * 每个包的 `index.html` 里都要原样带上这一条（壳不替应用注入：包自持的文档，
 * 它的权限就该写在它自己的文件里），六个应用的应用侧用例把这条与应用 html 里的
 * `content` 逐字比对（AP-014），改一处就会红。
 *
 * `'self'` 在应用窗口里就是 `airship://<id>`——包里的东西只能引包里的东西。
 * `ipc:` 留着是 preload 那侧通道的历史写法，跟 `blob:` 一起不影响 `'self'` 的边界。
 *
 * `style-src` 要 `blob:`：文档源从 `file://` 换成 `airship://<id>` 之后，
 * foliate-js 往章节 iframe 里注入的那份样式表变成了 `blob:airship://books/…`，
 * 没有 `blob:` 就被拦掉——2026-11-07 截图走查真撞上过，书能画但章节自带排版丢了。
 * `blob:` 只放行同源创建的 blob，不是把口子开到外部。
 * `'unsafe-inline'` 同理保留：React 的 inline style 与主题变量要吃它，收紧它是一次独立的契约变更。
 */
export const AIRSHIP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' blob: 'unsafe-inline'; " +
  "img-src 'self' blob: data:; font-src 'self' data:; frame-src 'self' blob:; " +
  "connect-src 'self' ipc: blob:; worker-src 'self' blob:;"

/**
 * 开发模式那一条：多允许 `'unsafe-inline'` 的脚本与到 dev server 的 ws/http 连接。
 *
 * `@vitejs/plugin-react` 在 dev 下要往 html 里塞一段内联的 react-refresh 前言，
 * `script-src 'self'` 会把它挡掉——热更就直接不工作。所以 dev 与产包用的是**两条**，
 * 由同一个注入器按模式选（src/sdk/cspPlugin.ts），产包那条永远是上面那份收紧的。
 * 这两条的差别只在 dev 里存在，出包产物里没有 dev 那份。
 */
export const AIRSHIP_CSP_DEV =
  "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' blob: 'unsafe-inline'; img-src 'self' blob: data: http://localhost:*; font-src 'self' data:; " +
  "frame-src 'self' blob:; connect-src 'self' ipc: blob: ws://localhost:* http://localhost:*; worker-src 'self' blob:;"

/**
 * 放宽 `connect-src` 的那两档：只给清单里声明了 `net` 的应用。
 *
 * 声明了 `net` 的应用自己发请求（对象存储、外部 API），要能连到用户填进去的那个端点——
 * 端点是运行期才知道的东西，写不进构建期就定死的 CSP，所以这一档放到 `http:` 与 `https:` 两个协议。
 * **只放 `connect-src`**：脚本、文档、frame 一概照旧收紧，"能连网"不等于"能加载外站脚本"。
 *
 * 窗口那侧还有另一半：跨源许可由壳在建窗口时按同一条能力位放行
 * （`src/shell/main/windows.ts`，判据见 `src/shell/specs/bridge.md` BR-011）。
 * 两处问的都是清单里那一个 `net`——少一处就是 dev 里绿、出包后死的那种坏法。
 */
export const AIRSHIP_CSP_NET =
  "default-src 'self'; script-src 'self'; style-src 'self' blob: 'unsafe-inline'; " +
  "img-src 'self' blob: data:; font-src 'self' data:; frame-src 'self' blob:; " +
  "connect-src 'self' ipc: blob: http: https:; worker-src 'self' blob:;"

/** 开发模式里声明了 `net` 的那一档：多允许连到任意 http/https 端点。 */
export const AIRSHIP_CSP_NET_DEV =
  "default-src 'self' http://localhost:* ws://localhost:*; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' blob: 'unsafe-inline'; img-src 'self' blob: data: http://localhost:*; font-src 'self' data:; " +
  "frame-src 'self' blob:; connect-src 'self' ipc: blob: ws://localhost:* http: https:; worker-src 'self' blob:;"

/**
 * 四档选哪一档——唯一的一处选择逻辑。
 *
 * 两个依据各管一件事：`bundle` 分产包与开发（react-refresh 要一段内联脚本），
 * `net` 分这个应用有没有在自己的清单里声明过自己连网。
 * 写在 CSP 这一边而不是注入器那一边，因为这四条字符串的差别本来就属于这一份文件。
 */
export function pickCsp(input: { bundle: boolean; net: boolean }): string {
  if (input.net) return input.bundle ? AIRSHIP_CSP_NET : AIRSHIP_CSP_NET_DEV
  return input.bundle ? AIRSHIP_CSP : AIRSHIP_CSP_DEV
}
