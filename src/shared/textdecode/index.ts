/**
 * 中文文本解码——一个按外部依赖规则管理的共享包。
 *
 * 为什么在共享层：墨读解 TXT 正文要用，vcp 解 srt/ass 字幕也要用，
 * 两个消费者、同一套坑（GBK、UTF-16 BOM）。放在任何一个应用里都会逼另一个复制一份。
 *
 * 顺序：BOM → UTF-8 严格 → GBK → UTF-8 容错。
 * BOM 必须先判：UTF-16 的中文字节常常能被 UTF-8 严格解"成功"，
 * 于是吐出一串乱码还轮不到 UTF-16——把 UTF-16 排在最后兜底是错的。
 */

export const TEXTDECODE_API_VERSION = 1

/** 解一段可能是 GBK / UTF-8 / UTF-16 的中文文本 */
export function decodeText(bytes: Uint8Array): string {
  // UTF-16LE BOM
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le').decode(bytes.subarray(2))
    } catch {
      /* 内核不支持就往下走 */
    }
  }
  // UTF-16BE BOM
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2))
    } catch {
      /* 同上 */
    }
  }
  // UTF-8 BOM：要剥掉，否则正文开头带一个不可见字符
  const body =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes

  const bad = /\uFFFD/
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(body)
  if (!bad.test(utf8)) return utf8

  try {
    const gbk = new TextDecoder('gbk').decode(body)
    if (!bad.test(gbk)) return gbk
  } catch {
    /* 该内核不支持 gbk */
  }
  return utf8
}
