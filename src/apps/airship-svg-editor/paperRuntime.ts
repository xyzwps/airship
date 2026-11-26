import paperScope from 'paper/dist/paper-core'

/**
 * Paper.js 的运行期接缝：布尔运算与 SVG 导入共用一个离屏 project。
 *
 * 真环境走 1×1 canvas；jsdom 这类没有 2D 上下文的环境用 Size 起手——
 * 两条都只是几何计算的底座，不往屏幕上画任何东西。
 *
 * 为什么引 `paper/dist/paper-core` 而不是主入口：主入口（paper-full）带 PaperScript 编译器，
 * 它内嵌的 acorn 在**模块加载时**就用 `new Function` 生成关键字表——包的 CSP
 * （script-src 'self'，无 unsafe-eval）会在窗口启动当场炸掉它（2026-11-07 截图走查抓到）。
 * 这里只用 Path/CompoundPath 的几何与 project.importSVG，core 版全够，eval 一个不需要。
 *
 * 值叫 `paperScope`：`paper` 这个名字留给 paper.d.ts 的全局类型命名空间，
 * 别在一个文件里同时占两头。
 */

let ready = false

export function ensurePaper(): void {
  if (ready) return
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  if (canvas && ctx) {
    canvas.width = 1
    canvas.height = 1
    paperScope.setup(canvas)
  } else {
    paperScope.setup(new paperScope.Size(1, 1))
  }
  paperScope.view.matrix = new paperScope.Matrix()
  ready = true
}

export { paperScope }
