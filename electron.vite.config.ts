import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// 三个角色目录：shell（外壳）/ apps（应用）/ shared（契约与共享包）。
// 渲染侧根目录设成 src，这样 apps/ 和 shared/ 都在根内，别名和 glob 都不用绕。
const SRC = resolve(__dirname, 'src')
const ALIAS = {
  '@shared': resolve(SRC, 'shared'),
  '@apps': resolve(SRC, 'apps'),
  '@shell': resolve(SRC, 'shell')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      // 主进程要 import 应用清单（apps/<id>/app.ts，纯数据），清单里用了 @shared
      alias: ALIAS
    },
    build: {
      rollupOptions: {
        input: { index: resolve(SRC, 'shell/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: ALIAS },
    build: {
      rollupOptions: {
        input: { index: resolve(SRC, 'shell/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: SRC,
    resolve: { alias: ALIAS },
    plugins: [react()],
    build: {
      // 两个入口：启动器窗口和单应用宿主窗口。
      // 一个窗口一个 html，才能各自拿到自己的 preload 身份。
      rollupOptions: {
        input: {
          launcher: resolve(SRC, 'shell/launcher.html'),
          app: resolve(SRC, 'shell/app.html')
        }
      }
    }
  }
})
