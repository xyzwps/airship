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
