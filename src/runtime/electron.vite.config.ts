import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 各区各是一个包（npm workspaces 链进 node_modules），所以这里没有别名表了：
// `@airship/contract`、`@airship/sdk` 这些说明符由 node 的解析负责，
// 与外部作者装上发布物之后看到的完全一样。
// 构建配置住在 runtime 这个包里：src 根在上一层，产物 out/ 与素材 assets/ 都在本包内。
const RUNTIME = resolve(__dirname)
// react 与 react-dom 只许有一份实例：workspace 软链进 node_modules 后，
// rollup 的 commonjs 互操作会把 react 当两个模块各包一遍（现象是 useState 读到 null）。
// dedupe 就是治这个的，别按"看起来多余"删它。
const DEDUPE = ['react', 'react-dom', 'react/jsx-runtime']

/**
 * 编译配置：**只有 main 与 preload 两个目标**。
 *
 * runtime 没有自己的文档——应用窗口加载的是各包自持的 index.html
 * （产包器逐应用构建，见 code/build-apps.mjs），所以这里没有 renderer 目标，
 * 产物里也不许出现 out/renderer（code/verify-installer.mjs 钉着这条反面）。
 *
 * dev 要起应用文档的 HMR 服务器，用的是另一份 electron.vite.dev.config.ts：
 * 它继承这份的 main/preload，另加一个只服务于 dev 的 renderer。
 * 两份分开是因为 electron-vite 在 configResolved 就校验 renderer 入口，
 * "编译时没有 renderer、dev 时有"没法在同一份配置里表达。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { dedupe: DEDUPE },
    build: {
      rollupOptions: {
        input: { index: resolve(RUNTIME, 'main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { dedupe: DEDUPE },
    build: {
      rollupOptions: {
        input: { index: resolve(RUNTIME, 'preload/index.ts') }
      }
    }
  }
})