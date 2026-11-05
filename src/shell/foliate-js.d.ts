/**
 * foliate-js 没有自带类型，这里只声明我们用到的面。
 * 故意保持 unknown/宽松：它是外部库，内部结构不该渗进我们的类型里，
 * 真正的形状在 ReaderView 的 FoliateView 接口里按用法收敛。
 */
declare module 'foliate-js/view.js' {
  export class ResponseError extends Error {}
  export class NotFoundError extends Error {}
  export class UnsupportedTypeError extends Error {}
  export const makeBook: (file: unknown) => Promise<unknown>
  export class View extends HTMLElement {}
}

declare module 'foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: unknown)
    init(): Promise<unknown>
  }
}

declare module 'foliate-js/mobi.js' {
  export const isMOBI: (file: unknown) => Promise<boolean>
  export class MOBI {
    constructor(options: { unzlib: (data: Uint8Array) => Uint8Array })
    open(file: unknown): Promise<unknown>
  }
}
