import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { airshipCspPlugin } from '@airship/sdk/vite'

/**
 * 单个 airship 包的构建配置——由 `code/build-apps.mjs` 逐个应用调用。
 *
 * 三条不显眼的规矩，都是"错了就装不起来"的那种：
 *
 *   1. `root` 就是那个应用目录。Vite 会把输入 html 相对 root 的路径**原样搬进产物**：
 *      root 设成 `src` 就会产出 `<out>/apps/life/index.html`，包根就不是一层 `index.html` 了。
 *      包根必须是入口本身，`airship://<id>/index.html` 才指得到它。
 *   2. `base: './'`。默认的 `/` 会在 html 里写出 `/assets/…`，那是相对盘符的地址；
 *      在 `airship://<id>` 这个 origin 下它指到协议根，而协议根只认包内路径——一加载就 404。
 *   3. 每个应用各跑一次构建。一次构建里放六个 html，Rollup 会把 React 抽成一个共享 chunk，
 *      六个包就互相依赖了；分开构建才是"一个包自带全部东西"。
 *      代价：React 复制六份，安装包体积微升——这是工作流换来的，不是体积换来的。
 *
 * 产物落在系统临时目录（AGENTS.md 的本机事实：中间产物不进仓库），
 * 由 build-apps.mjs 装成 `<临时目录>/<id>.airship/` 后再进 `dist-apps/`。
 */

const SRC = resolve(import.meta.dirname, '..', 'src')
const APP_ID = process.env.AIRSHIP_APP_ID ?? ''
const APP_OUT = process.env.AIRSHIP_APP_OUT ?? ''

if (APP_ID === '') throw new Error('app.vite.config.ts 要由 code/build-apps.mjs 调用：缺 AIRSHIP_APP_ID')
if (APP_OUT === '') throw new Error('app.vite.config.ts 要由 code/build-apps.mjs 调用：缺 AIRSHIP_APP_OUT')

export default defineConfig({
  root: resolve(SRC, 'apps', APP_ID),
  base: './',
  resolve: {
    // 同壳侧那条：一个包内两份 react 会让 hooks 立刻炸
    dedupe: ['react', 'react-dom', 'react/jsx-runtime']
  },
  plugins: [react(), airshipCspPlugin()],
  build: {
    outDir: APP_OUT,
    emptyOutDir: true,
    // 包是磁盘上的静态文件，不需要 sourcemap；出问题时用 dev 那条路看源码
    sourcemap: false,
    // 一个包一个 chunk 就够，再切只会让包内多一层加载顺序依赖
    modulePreload: { polyfill: false }
  }
})
