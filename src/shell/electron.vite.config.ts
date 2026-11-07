import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { airshipCspPlugin } from '@airship/sdk/vite'

// 四个区各是一个包（npm workspaces 链进 node_modules），所以这里没有别名表了：
// `@airship/contract`、`@airship/sdk` 这些说明符由 node 的解析负责，
// 与外部作者装上发布物之后看到的完全一样。
// 构建配置住在壳这个包里：src 根在上一层，产物 out/ 与素材 assets/ 都在本包内
const SRC = resolve(__dirname, '..')
const SHELL = resolve(__dirname)
// react 与 react-dom 只许有一份实例：workspace 软链进 node_modules 后，
// rollup 的 commonjs 互操作会把 react 当两个模块各包一遍（现象是 useState 读到 null）。
// dedupe 就是治这个的，别按"看起来多余"删它。
const DEDUPE = ['react', 'react-dom', 'react/jsx-runtime']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { dedupe: DEDUPE },
    build: {
      rollupOptions: {
        input: { index: resolve(SHELL, 'main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { dedupe: DEDUPE },
    build: {
      rollupOptions: {
        input: { index: resolve(SHELL, 'preload/index.ts') }
      }
    }
  },
  renderer: {
    // 渲染根还是 src：dev 时应用窗口的文档地址是 <devUrl>/apps/<id>/index.html，
    // 那棵树必须在服务端可达——这是"改一行组件即热更"的前提。
    root: SRC,
    resolve: { dedupe: DEDUPE },
    plugins: [react(), airshipCspPlugin()],
    build: {
      // 壳只构建自己的那一份文档：启动器。
      // 应用窗口加载的是各包自持的 index.html（产包器逐应用构建，见 code/build-apps.mjs），
      // 所以这里再也不会出现 "app" 这个入口——壳的产物里没有任何应用代码。
      rollupOptions: {
        input: {
          launcher: resolve(SHELL, 'launcher.html')
        }
      }
    }
  }
})
