/**
 * S3 的后端：随包自带、由 runtime 起成它自己的一份进程。
 *
 * 有它靠的是约定，不是清单：产包流水把这份文件（连同它 import 的 `backendStore.ts`）
 * 编成包根那份 `backend.js`，runtime 在包里看到那个条目才起进程。
 * 网络的事全在这里——渲染侧只剩填表、列表与进度条，清单因此不再要 `net`、
 * fs.read / fs.write 这三档（那条能力位与它的 CSP、同源豁免整族已于 2026-11-24 退场）。
 *
 * 线与规矩（契约见 airship 文档的 backend 一节）：
 *   - 启动后**第一件事**发 `{ ready: true }`，runtime 才把调用喂进来；
 *   - runtime 发来 `{ seq, method, payload }`，回 `{ seq, ok: true, value }` 或 `{ seq, ok: false, error }`；
 *   - 上传/下载是先回执、后干活：进度与结局走 `{ event: true, method, payload }` 主动推。
 *
 * 它崩了不拖累窗口：在途的调用听到「后端程序中途退出」，正在搬的传输靠
 * `backend:exited` 事件让界面就地判失败；下一次调用拉起新的进程。
 */

import { mkdir, open, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { handle, type BackendIo, type Sink } from './backendStore'

/** runtime（utilityProcess）给的消息端口——Electron 那份类型不在这里，声明够用的形状 */
interface ParentPort {
  on(
    event: 'message',
    handler: (ev: { data?: { seq?: number; method?: string; payload?: unknown } }) => void
  ): void
  postMessage(message: unknown): void
}

const parent = (process as unknown as { parentPort: ParentPort }).parentPort

/** 主动推事件：runtime 把它转成 backend:event，只有本应用的窗口收得到 */
function emit(method: string, payload?: unknown): void {
  parent.postMessage({ event: true, method, payload })
}

/** 真盘上的 io：读按区间取（不整份进内存），写是边接边写的落点 */
const io: BackendIo = {
  fileSize: async (path) => {
    try {
      const fh = await open(path, 'r')
      try {
        const st = await fh.stat()
        // 目录不算文件：拖到文件夹上要与"读不出来"念同一句（判据 OS-045）
        return st.isFile() ? st.size : null
      } finally {
        await fh.close()
      }
    } catch {
      return null
    }
  },

  readRange: async (path, start, length) => {
    const fh = await open(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      const { bytesRead } = await fh.read(buf, 0, length, start)
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead)
    } finally {
      await fh.close()
    }
  },

  sink: (path): Sink => {
    let fh: Promise<import('node:fs/promises').FileHandle> | null = null
    let bytes = 0
    const ensure = async (): Promise<import('node:fs/promises').FileHandle> => {
      if (!fh) {
        await mkdir(dirname(path), { recursive: true })
        fh = open(path, 'w')
      }
      return fh
    }
    return {
      append: async (chunk) => {
        const h = await ensure()
        await h.write(chunk, 0, chunk.byteLength, bytes)
        bytes += chunk.byteLength
      },
      finish: async () => {
        if (fh) await (await fh).close()
        else {
          // 零字节对象也值得落一个空文件：下载成功了却说"什么文件都没有"是撒谎
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, Buffer.alloc(0))
        }
        return bytes
      },
      abort: async () => {
        if (fh) await (await fh).close().catch(() => undefined)
        await rm(path, { force: true }).catch(() => undefined)
      }
    }
  }
}

parent.on('message', (event) => {
  const { seq, method, payload } = event.data ?? {}
  void handle(String(method), payload, io, emit)
    .then((value) => parent.postMessage({ seq, ok: true, value }))
    .catch((e: unknown) => {
      // 回给前端的 error 就是要念给用户听的那句人话——别回堆栈
      parent.postMessage({ seq, ok: false, error: e instanceof Error ? e.message : String(e) })
    })
})

parent.postMessage({ ready: true })
