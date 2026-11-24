/**
 * __APP_NAME__ 的后端：随包自带、由 runtime 起成它自己的一份进程。
 *
 * 有它靠的是约定，不是清单：这个文件由产包流水编成包根那份 `backend.js`，
 * runtime 在包里看到那个条目才起进程。删掉这个文件，应用就没有后台。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 这个计数住在内存里：窗口一关进程就收掉，数字归零。
 *     要跨重启留住数字，写 `AIRSHIP_DATA_DIR`——todo 模板的 backend.ts 就是那么办的。
 */

/** runtime（utilityProcess）给的消息端口——Electron 那份类型不在模板依赖里，这里自己声明够用的形状 */
interface ParentPort {
  on(event: 'message', handler: (ev: { data?: { seq?: number; method?: string } }) => void): void
  postMessage(message: unknown): void
}

const parent = (process as unknown as { parentPort: ParentPort }).parentPort

/** 计数：这个应用唯一的数字，它在这里——前端不自存一份，每次读的都是进程里这一个 */
let count = 0

const handlers: Record<string, () => unknown> = {
  get: () => count,
  inc: () => ++count
}

parent.on('message', (event) => {
  const { seq, method } = event.data ?? {}
  try {
    const handler = method ? handlers[method] : undefined
    if (!handler) throw new Error(`后端不认的方法：${method}`)
    parent.postMessage({ seq, ok: true, value: handler() })
  } catch (e) {
    // 回给前端的 error 就是要念给用户听的人话——别回堆栈
    parent.postMessage({ seq, ok: false, error: e instanceof Error ? e.message : String(e) })
  }
})

parent.postMessage({ ready: true })
