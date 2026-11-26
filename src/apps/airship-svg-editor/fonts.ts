import { parse } from 'opentype.js'
import type { Font } from 'opentype.js'

/**
 * 字体层：把用户选中的字体文件解析成 opentype.Font，并喂给 CSS 显示与导出描轮廓。
 *
 * 与单文件版的差别只有一处——字体来源从浏览器枚举本机字体改成
 * "dialog 选一个 .ttf/.otf/.ttc 文件"；TTC 拆面、cmap 子表修剪、按 postscriptName
 * 选面这些底层行为逐字保留（那是 opentype.js 解不开某些文件的原因，不是随手写的）。
 */

export interface ParsedFont {
  font: Font
  /** 该面单独的字体缓冲（注册 CSS FontFace 用） */
  faceBuffer: ArrayBuffer
}

/** opentype 1.x 的字体名住在 names 表里：postScriptName.en（回落第一个语言值） */
export function fontPostscriptName(font: Font): string {
  const entry = font.names?.postScriptName as Record<string, string> | undefined
  if (!entry) return ''
  return entry.en || Object.values(entry)[0] || ''
}

/** family 名（en 优先）与 style 名：界面念「Family Style」用的就是这两个 */
export function fontFamilyName(font: Font): string {
  const entry = font.names?.fontFamily as Record<string, string> | undefined
  return entry ? entry.en || Object.values(entry)[0] || '' : ''
}

export function fontSubfamilyName(font: Font): string {
  const entry = font.names?.fontSubfamily as Record<string, string> | undefined
  return entry ? entry.en || Object.values(entry)[0] || '' : ''
}

function readTag(view: DataView, offset: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(view.getUint8(offset + i))
  return s
}

export function isTTC(buffer: ArrayBuffer): boolean {
  return readTag(new DataView(buffer), 0, 4) === 'ttcf'
}

/** TTC → 每面一个独立 sfnt 缓冲（重建表目录，数据按 4 字节对齐追加） */
export function splitTTC(buffer: ArrayBuffer): ArrayBuffer[] {
  const view = new DataView(buffer)
  if (!isTTC(buffer)) return [buffer]
  const numFonts = view.getUint32(8)
  const out: ArrayBuffer[] = []
  for (let f = 0; f < numFonts; f += 1) {
    const fontOffset = view.getUint32(12 + f * 4)
    const numTables = view.getUint16(fontOffset + 4)
    interface Table {
      tag: ArrayBuffer
      checksum: number
      data: ArrayBuffer
      at: number
    }
    const tables: Table[] = []
    let dataStart = 12 + numTables * 16
    for (let t = 0; t < numTables; t += 1) {
      const rec = fontOffset + 12 + t * 16
      const dataOff = view.getUint32(rec + 8)
      const dataLen = view.getUint32(rec + 12)
      tables.push({
        tag: buffer.slice(rec, rec + 4),
        checksum: view.getUint32(rec + 4),
        data: buffer.slice(dataOff, dataOff + dataLen),
        at: dataStart
      })
      dataStart += dataLen + ((4 - (dataLen % 4)) % 4)
    }
    const face = new ArrayBuffer(dataStart)
    const faceView = new DataView(face)
    new Uint8Array(face).set(new Uint8Array(buffer, fontOffset, 12), 0)
    faceView.setUint16(4, numTables)
    tables.forEach((tab, i) => {
      const rec = 12 + i * 16
      new Uint8Array(face).set(new Uint8Array(tab.tag), rec)
      faceView.setUint32(rec + 4, tab.checksum)
      faceView.setUint32(rec + 8, tab.at)
      faceView.setUint32(rec + 12, tab.data.byteLength)
      new Uint8Array(face).set(new Uint8Array(tab.data), tab.at)
    })
    out.push(face)
  }
  return out
}

/** 某些字体的 cmap 带 Microsoft 才认的子表；只留 format 4/12/14（或老式 0,0），并把留下的重排进表目录 */
export function pruneCmap(buffer: ArrayBuffer): ArrayBuffer {
  const view = new DataView(buffer)
  if (isTTC(buffer)) return buffer
  const numTables = view.getUint16(4)
  let cmapAt = -1
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16
    if (readTag(view, rec, 4) === 'cmap') {
      cmapAt = view.getUint32(rec + 8)
      break
    }
  }
  if (cmapAt < 0) return buffer
  const numSub = view.getUint16(cmapAt + 2)
  const good: Array<{ platformId: number; encodingId: number; offset: number }> = []
  for (let i = 0; i < numSub; i += 1) {
    const rec = cmapAt + 4 + i * 8
    const pid = view.getUint16(rec)
    const eid = view.getUint16(rec + 2)
    const off = view.getUint32(rec + 4)
    const format = view.getUint16(cmapAt + off)
    const keepable = format === 4 || format === 12 || format === 14 || (format === 0 && pid === 1 && eid === 0)
    if (keepable) good.push({ platformId: pid, encodingId: eid, offset: off })
  }
  if (good.length === 0 || good.length === numSub) return buffer
  good.forEach((entry, i) => {
    const rec = cmapAt + 4 + i * 8
    view.setUint16(rec, entry.platformId)
    view.setUint16(rec + 2, entry.encodingId)
    view.setUint32(rec + 4, entry.offset)
  })
  view.setUint16(cmapAt + 2, good.length)
  return buffer
}

/** 缓冲 → 可解析的面列表 */
export function fontFaces(buffer: ArrayBuffer): ArrayBuffer[] {
  return splitTTC(buffer).map(pruneCmap)
}

/**
 * 解析一个字体缓冲，优先取 postscriptName 命中的面；
 * 一个面都解析不了 → throw "Unparseable font file"（与单文件版同话，由调用方转成界面 toast）。
 */
export function parseFontBuffer(buffer: ArrayBuffer, postscriptName = ''): ParsedFont {
  let fallback: ParsedFont | null = null
  for (const face of fontFaces(buffer)) {
    let font: Font | null = null
    try {
      font = parse(face)
    } catch {
      continue
    }
    if (!font) continue
    if (postscriptName && fontPostscriptName(font) === postscriptName) return { font, faceBuffer: face }
    if (!fallback) fallback = { font, faceBuffer: face }
  }
  if (!fallback) throw new Error('Unparseable font file')
  return fallback
}

/** CSS 家族名：albedo- 前缀 + 清洗过的 postscriptName（与注册 FontFace 用的是同一个） */
export function cssFamilyFor(postscriptName: string): string {
  return `albedo-${String(postscriptName).replace(/[^A-Za-z0-9_-]/g, '')}`
}

/** 把解析出的面注册为可渲染的 CSS 字体；失败时回落到 local('…') */
export async function registerCssFont(cssFamily: string, faceBuffer: ArrayBuffer, familyName: string): Promise<void> {
  const localSafe = String(familyName).replace(/["'\\]/g, '')
  try {
    const FontFaceCtor = (globalThis as { FontFace?: typeof FontFace }).FontFace
    const fontFace = FontFaceCtor ? new FontFaceCtor(cssFamily, faceBuffer) : null
    if (!fontFace) throw new Error('FontFace 不可用')
    await fontFace.load()
    ;(document as Document & { fonts: FontFaceSet }).fonts.add(fontFace)
  } catch {
    const style = document.createElement('style')
    style.textContent = `@font-face { font-family: "${cssFamily}"; src: local('${localSafe}'); }`
    document.head.appendChild(style)
  }
}

/** 字体展示名："Family Style"（family 与 style 都在才拼，与单文件版 rt 一致） */
export function fontDisplayName(entry: { family: string; style: string }): string {
  return [entry.family, entry.style].filter(Boolean).join(' ')
}

/** 字体列表排序：family 再 style（localeCompare 链，与单文件版 Vr 一致） */
export function compareFonts(
  a: { family: string; style: string },
  b: { family: string; style: string }
): number {
  return (
    String(a.family || '').localeCompare(String(b.family || '')) ||
    String(a.style || '').localeCompare(String(b.style || ''))
  )
}
