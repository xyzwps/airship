/**
 * 打勾勾的后端：随包自带、由 runtime 起成它自己的一份进程。
 *
 * 有它靠的是约定，不是清单：产包流水把这份文件（连同它 import 的 `backendStore.ts`）
 * 编成包根那份 `backend.js`，runtime 在包里看到那个条目才起进程。
 * 数据的事全在这里——渲染侧只剩对话框与展示，清单因此不再要 fs.read / fs.write。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 数据目录从 `AIRSHIP_DATA_DIR` 拿——与从前 `api.fs` 的 data 目录是同一份，老数据原地不动。
 *
 * 它崩了不拖累窗口：在途的调用会听到「后端程序中途退出」，下一次调用拉起新的进程。
 */

import { mkdir, copyFile, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { handle, type BackendIo } from './backendStore'

/** runtime（utilityProcess）给的消息端口——Electron 那份类型不在这里，声明够用的形状 */
interface ParentPort {
  on(event: 'message', handler: (ev: { data?: { seq?: number; method?: string; payload?: unknown } }) => void): void
  postMessage(message: unknown): void
}

const parent = (process as unknown as { parentPort: ParentPort }).parentPort
const DATA_DIR = process.env.AIRSHIP_DATA_DIR ?? '.'

/** 真盘上的 io：写之前把父目录带出来，读不到就报原因 */
const io: BackendIo = {
  dataPath: (name) => join(DATA_DIR, name),

  readText: async (path) => {
    try {
      return await readFile(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  },

  writeText: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
  },

  copyFile: async (source, target) => {
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  },

  removeFile: (path) => unlink(path)
}

parent.on('message', (event) => {
  const { seq, method, payload } = event.data ?? {}
  void handle(String(method), payload, io)
    .then((value) => parent.postMessage({ seq, ok: true, value }))
    .catch((e: unknown) => {
      // 回给前端的 error 就是要念给用户听的人话——别回堆栈
      parent.postMessage({ seq, ok: false, error: e instanceof Error ? e.message : String(e) })
    })
})

parent.postMessage({ ready: true })
