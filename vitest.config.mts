import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * 单测配置。
 *
 * 别名与 electron.vite.config.ts / 两个 tsconfig 保持一致：测试里也走 @shared 而不是 ../../ 爬楼。
 * 默认环境是 node（壳的主进程服务、纯逻辑都在 node 下测）；
 * 需要 DOM 的用例在文件顶部写 `// @vitest-environment jsdom`，只给那几个文件开界面环境。
 */

const SRC = fileURLToPath(new URL('./src', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@shared': `${SRC}/shared`,
      '@apps': `${SRC}/apps`,
      '@shell': `${SRC}/shell`,
      // 测试工装住在壳的区域里（fakeAirship 是壳的替身），别的区域用别名引它，不爬楼
      '@tests': `${SRC}/shell/tests`
    }
  },
  test: {
    setupFiles: ['./src/shell/tests/setup.ts']
  }
})
