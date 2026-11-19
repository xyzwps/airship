import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { airshipCspPlugin } from '@airship/sdk/vite'
import compile from './electron.vite.config.ts'

// dev 专用配置：继承编译配置的 main/preload，另加一个 renderer。
// 这个 renderer **只起 HMR 服务器，从不参与编译**——`just compile` 走的是
// electron.vite.config.ts（没有 renderer），runtime 的产物里没有任何应用代码。
const SRC = resolve(__dirname, '..')
const APPS = resolve(SRC, 'apps')
const DEDUPE = ['react', 'react-dom', 'react/jsx-runtime']

// 渲染根还是 src：dev 时应用窗口的文档地址是 <devUrl>/apps/<id>/index.html，
// 那棵树必须在服务端可达——这是"改一行组件即热更"的前提。
// 入口逐个应用列出来（specs/tests 这类没有 index.html 的目录不算）。
const appEntries = Object.fromEntries(
  readdirSync(APPS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(APPS, d.name, 'index.html')))
    .map((d) => [d.name, resolve(APPS, d.name, 'index.html')])
)

export default defineConfig({
  ...compile,
  renderer: {
    root: SRC,
    resolve: { dedupe: DEDUPE },
    plugins: [react(), airshipCspPlugin()],
    build: {
      rollupOptions: { input: appEntries }
    }
  }
})