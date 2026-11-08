import { defineConfig } from 'vitest/config'

/**
 * 单测配置。
 *
 * 没有别名了：`@airship/*` 是 npm workspaces 链出来的真包，测试与产品走同一条 node 解析——
 * 上一条写的是"测试里也走 @shared 而不是爬楼"，那个 `@shared` 已经不存在了。
 * 默认环境是 node（壳的主进程服务、纯逻辑都在 node 下测）；
 * 需要 DOM 的用例在文件顶部写 `// @vitest-environment jsdom`，只给那几个文件开界面环境。
 *
 * 用例跟着它们管的代码走（`src/shell/tests`、`src/sdk/tests`、`src/apps/<id>/tests`、
 * `src/shared/<包>/tests`），所以这里不写 include 名单，vitest 自己递归找。
 */

export default defineConfig({
  test: {
    // templates/ 里的用例是范本的样例（编号还没落到真应用上），不跟着仓库一起跑
    exclude: ['templates/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/shell/tests/setup.ts'],
    server: {
      deps: {
        /**
         * `@airship/*` 是**源码包**（exports 直接指向 .ts），所以不能让 vitest 把它们
         * 外部化给 Node 自己加载：Node 的 ESM 解不了仓库里那种不带扩展名的相对 import，
         * 结果是 `import * as testing from '@airship/sdk/testing'` 拿到一个空模块——
         * 不报错，只是什么都没有，比报错难查得多。
         * 交给 vite 处理之后，源码包与仓库内文件走同一条变换管线。
         *
         * `@aws-sdk/*` 不在这一列里，而且不该在：它被外部化之后挑的是 Node 那一档传输，
         * 换 `globalThis.fetch` 换不到它（请求会真发到机器上的端点去）。
         * S3 那个应用的用例因此起一个真的内存 HTTP 服务当端点，见 `src/apps/s3/tests/helpers/fakeS3.ts`。
         */
        inline: [/^@airship\//]
      }
    }
  }
})
