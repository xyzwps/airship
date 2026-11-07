import type { AppApi } from '@airship/contract'
import { t as translate, tn, pickLang, type Lang } from './i18n.ts'
import {
  COMMAND_TYPES,
  GRID_SIZES,
  HISTORY_LIMIT,
  EDIT_MERGE_MS,
  SAVE_DEBOUNCE_MS,
  UNDERLAY_SAVE_DEBOUNCE_MS,
  UNDERLAY_SRC_MAX,
  UNDERLAY_JSON_MAX,
  RECENT_FONTS_MAX,
  SHAPE_HOTKEYS,
  SHAPE_TYPES,
  PALETTE,
  makeId,
  normalizeDoc,
  normalizeCommands,
  normalizeUnderlay,
  makeStarterDoc,
  isHexColor,
  regularPolygonPoints,
  pointCloudFit,
  defaultShapeName,
  clamp,
  type Doc,
  type Underlay,
  type Shape,
  type PathCommand,
  type ShapeType
} from './model.ts'
import { createStore, type Store } from './store.ts'
import {
  fmt,
  fmt2,
  commandsToPath,
  shapeBBox,
  pointBefore,
  shapeToPathAttr,
  unionBoxes,
  translateShape,
  resizeBounds,
  reshapeToBounds,
  textBaselineY,
  clampZoom,
  stepZoom,
  zoomFromWheel,
  zoomLabel,
  type Box,
  type TextFontLike
} from './geom.ts'
import {
  snapMove,
  snapResize,
  snapPoint,
  type SnapGuide,
  type SnapOptions as SnapOptionsFor
} from './snap.ts'
import { alignOffset, distributeOffsets, type AlignKind } from './align.ts'
import { runBoolean, type BooleanKind } from './booleanOps.ts'
import { importSvg, findByAlbedoKey, ancestorOpacityProduct } from './svgImport.ts'
import {
  exportPatched,
  exportFromModel,
  shapeSignature,
  type SourceEntryRecord
} from './svgExport.ts'
import {
  parseFontBuffer,
  fontPostscriptName,
  fontFamilyName,
  fontSubfamilyName,
  cssFamilyFor,
  registerCssFont,
  type ParsedFont
} from './fonts.ts'

/**
 * Albedo 工作台：文档状态、历史、语言、持久化、渲染、手势、IO 与接线的所在。
 *
 * 结构沿用单文件版"一份状态一个控制器"的形状，因为它的行为（历史合并、
 * 保存防抖、选择回落）全部挂在这份状态的时序上，拆成多份共享反而把时序打散。
 * 纯计算（几何/吸附/对齐/布尔/SVG 进出/字体解析）都住在各自的小模块里，这里是唯一的使用方。
 */

/** 单次手势：一次按下到松手最多产一条历史；没 moved 就一条都不产 */
interface GestureBase {
  start: { x: number; y: number }
  moved: boolean
  before?: string | null
}

interface MoveGesture extends GestureBase {
  kind: 'move'
  ids: string[]
  originals: Shape[]
  bounds: Box
}

interface ResizeGesture extends GestureBase {
  kind: 'resize'
  ids: string[]
  originals: Shape[]
  bounds: Box
  originalBounds: Box
  handle: string
  keepAspect: boolean
}

interface NodeGesture extends GestureBase {
  kind: 'node'
  shapeId: string
  cmdId: string
  part: string
  original: Shape
}

interface UnderlayGesture extends GestureBase {
  kind: 'underlay-move' | 'underlay-resize'
  part: string
  pointerOffset: { x: number; y: number }
  original: { x: number; y: number; w: number; h: number }
  before: null
}

interface MarqueeGesture extends GestureBase {
  kind: 'marquee'
  additive: boolean
  beforeSelection: string[]
}

type Gesture = MoveGesture | ResizeGesture | NodeGesture | UnderlayGesture | MarqueeGesture

/** 图层行的类型角标（椭圆是 E——与插入快捷键的 O 分属两套，沿用原表） */
const SHAPE_TYPE_CODE: Record<ShapeType, string> = {
  rect: 'R',
  ellipse: 'E',
  circle: 'C',
  polygon: 'G',
  line: 'L',
  text: 'T',
  path: 'P'
}

const BOOLEAN_KINDS: BooleanKind[] = ['unite', 'subtract', 'intersect', 'exclude']

/** 吸附阈值：6 个屏幕像素换算成 doc 单位 */
const SNAP_THRESHOLD_PX = 6

function rectsIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 不依赖 Buffer/atob：分块转 base64 成 dataURL（桌布的 src 就是这份字节） */
export function bufferToDataUrl(bytes: Uint8Array, mime: string): string {
  const b64c = (n: number): string => BASE64_ALPHABET.charAt(n)
  let b64 = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    b64 += b64c((n >> 18) & 63) + b64c((n >> 12) & 63) + b64c((n >> 6) & 63) + b64c(n & 63)
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    b64 += b64c((n >> 18) & 63) + b64c((n >> 12) & 63) + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    b64 += b64c((n >> 18) & 63) + b64c((n >> 12) & 63) + b64c((n >> 6) & 63) + '='
  }
  return `data:${mime};base64,${b64}`
}

/** 从位图文件头读原始尺寸；读不出（SVG/WebP 变体/坏了）返回 null，交给 Image 兜底 */
export function sniffImageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16le = (o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
  const u32be = (o: number): number => ((b[o] ?? 0) * 0x1000000) + ((b[o + 1] ?? 0) << 16 | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0))
  const u32le = (o: number): number => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) * 0x1000000)
  const tag = (o: number, str: string): boolean => {
    for (let i = 0; i < str.length; i += 1) if ((b[o + i] ?? -1) !== str.charCodeAt(i)) return false
    return true
  }
  if (b.length < 16) return null
  if (b[0] === 0x89 && tag(1, 'PNG') && tag(12, 'IHDR')) {
    const w = u32be(16)
    const h = u32be(20)
    return w > 0 && h > 0 ? { w, h } : null
  }
  if (tag(0, 'GIF8')) {
    const w = u16le(6)
    const h = u16le(8)
    return w > 0 && h > 0 ? { w, h } : null
  }
  if (tag(0, 'BM') && b.length >= 26) {
    const w = u32le(18)
    const h = Math.abs(u32le(22))
    return w > 0 && h > 0 ? { w, h } : null
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o += 1
        continue
      }
      const marker = b[o + 1] ?? 0
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { h: u16le(o + 5), w: u16le(o + 7) }
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        o += 2
        continue
      }
      o += 2 + u16le(o + 2)
    }
    return null
  }
  if (tag(0, 'RIFF') && tag(8, 'WEBP') && b.length >= 31) {
    if (tag(12, 'VP8X')) {
      const w = 1 + ((b[25] ?? 0) | ((b[26] ?? 0) << 8) | ((b[27] ?? 0) << 16))
      const h = 1 + ((b[28] ?? 0) | ((b[29] ?? 0) << 8) | ((b[30] ?? 0) << 16))
      return w > 0 && h > 0 ? { w, h } : null
    }
    if (tag(12, 'VP8L')) {
      const bits = u32le(21)
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) }
    }
    if (tag(12, 'VP8 ') && (b[26] ?? 0) === 0x9d && (b[27] ?? 0) === 0x01 && (b[28] ?? 0) === 0x2a) {
      return { w: u16le(27 + 2) & 0x3fff, h: u16le(29 + 2) & 0x3fff }
    }
  }
  return null
}

export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

interface RecentFont {
  postscriptName: string
  family: string
  style: string
  /** 应用数据目录 fonts/ 下复制存的那份的文件名 */
  file: string
}

interface FontEntry {
  /** opentype.js 的 Font；鸭子面在 geom（测量）与 svgExport（描轮廓）各取所需 */
  font: ParsedFont['font']
  cssFamily: string
  family: string
  style: string
}

export class AlbedoWorkspace {
  readonly host: HTMLElement
  readonly api: AppApi
  readonly store: Store

  els: Record<string, HTMLElement> = {}
  svg!: SVGSVGElement

  state = {
    doc: null as Doc | null,
    lang: 'en' as Lang,
    langMode: 'auto' as 'auto' | 'zh' | 'en',
    saveStatus: 'saved' as 'saved' | 'saving' | 'unsaved',
    selectedId: null as string | null,
    selectedIds: [] as string[],
    selectedCmdId: null as string | null,
    grid: { visible: false, size: 8 },
    snapEnabled: true,
    snapGuides: [] as Array<{ axis: 'x' | 'y'; value: number; kind: string }>,
    marquee: null as null | { x: number; y: number; w: number; h: number },
    pathEdit: true,
    undo: [] as string[],
    redo: [] as string[],
    gesture: null as Gesture | null,
    editBefore: null as string | null,
    editTimer: null as ReturnType<typeof setTimeout> | null,
    saveTimer: null as ReturnType<typeof setTimeout> | null,
    toastTimer: null as ReturnType<typeof setTimeout> | null,
    tipTimer: null as ReturnType<typeof setTimeout> | null,
    tipDismissed: false,
    canvasTrigger: null as HTMLElement | null,
    underlay: null as Underlay | null,
    underlayAdjust: false,
    underlaySaveTimer: null as ReturnType<typeof setTimeout> | null,
    underlayWarned: false,
    underlayPersistFailed: false,
    underlayImportToken: 0,
    svgImportToken: 0,
    starter: false,
    source: null as SourceState | null,
    sourceSerial: 0,
    sourcePersisted: false,
    sourceByDoc: new Map<string, SourceState | null>(),
    leftTab: 'insert',
    rightTab: null as string | null,
    layerDrag: null as string | null,
    uiScale: 1,
    zoom: 1,
    fonts: new Map<string, FontEntry>(),
    recentFonts: [] as RecentFont[],
    fontBusy: false
  }

  private abortController = new AbortController()
  private booted = false

  constructor(host: HTMLElement, api: AppApi) {
    this.host = host
    this.api = api
    this.store = createStore(api)
    this.collectElements()
  }

  /** 静态骨架里那批带 id 的节点；fontModal/importSvgFile/underlayFile 三族在移植时删掉了 */
  private collectElements(): void {
    const ids = [
      'stage', 'stageDefs', 'gridLayer', 'shapeLayer', 'underlayLayer', 'overlay', 'canvasBg',
      'layers', 'layerCount', 'leftRail', 'leftPanelBody', 'inspectorRail', 'inspector',
      'underlayEmpty', 'underlayControls', 'underlayImportBtn', 'underlayThumb', 'underlayName', 'underlayMeta',
      'underlayVisibleBtn', 'underlayAdjustBtn', 'underlayReplaceBtn', 'underlayRemoveBtn', 'underlayHint',
      'underlayToggle', 'underlayPopover', 'underlayPopoverClose', 'underlayStateDot',
      'importSvgBtn', 'insertSvgBtn', 'stageDrop', 'docTitle', 'saveState',
      'coordStatus', 'shapeStatus', 'nodeStatus', 'canvasTip', 'emptyCanvas', 'artboardWrap', 'stageBody',
      'zoomInBtn', 'zoomOutBtn', 'zoomFitBtn', 'zoomLabel', 'canvasSizeBtn', 'canvasSizeLabel',
      'canvasModal', 'canvasWidthInput', 'canvasHeightInput', 'canvasRatioChip', 'canvasSizeError', 'canvasApplyBtn',
      'undoBtn', 'redoBtn', 'newBtn', 'copyBtn', 'exportBtn', 'gridToggle', 'gridSize', 'snapToggle', 'langSelect', 'toast'
    ]
    for (const id of ids) {
      const el = this.host.querySelector(`#${id}`)
      if (!el) throw new Error(`Albedo 骨架缺节点 #${id}`)
      this.els[id] = el as HTMLElement
    }
    this.svg = this.el('stage') as unknown as SVGSVGElement
  }

  /** 骨架节点取用：缺了就是要炸——不返回 undefined，让"缺节点"喊出来而不是静默空操作 */
  el(id: string): HTMLElement {
    const found = this.els[id]
    if (!found) throw new Error(`Albedo 骨架缺节点 #${id}`)
    return found
  }

  /* ================= 语言 ================= */

  /** 取词门面：用例也经它断言界面上读得到哪句话 */
  t(key: string, vars: Record<string, unknown> = string_): string {
    return translate(this.state.lang, key, vars)
  }

  tf(key: string, count: number, vars: Record<string, unknown> = string_): string {
    return tn(this.state.lang, key, count, vars)
  }

  /* ================= 快照 / 历史 / 自动保存 ================= */

  snapshot(): string {
    return JSON.stringify(this.state.doc)
  }

  pushHistory(snap: string): boolean {
    const st = this.state
    if (typeof snap !== 'string' || snap === this.snapshot()) return false
    st.undo.push(snap)
    if (st.undo.length > HISTORY_LIMIT) st.undo.shift()
    st.redo.length = 0
    this.syncUndoRedoButtons()
    return true
  }

  /** 连续输入的合并窗口起手：第一次记下改前快照 */
  beginEdit(): void {
    const st = this.state
    if (st.editBefore === null) st.editBefore = this.snapshot()
    if (st.editTimer) clearTimeout(st.editTimer)
    st.editTimer = setTimeout(() => {
      this.commitEdit()
      void this.saveNow()
    }, EDIT_MERGE_MS)
  }

  /** 一段连续输入收尾：只产生一条 undo，并立刻落盘 */
  commitEdit(): void {
    const st = this.state
    if (st.editTimer) {
      clearTimeout(st.editTimer)
      st.editTimer = null
    }
    if (st.editBefore === null) return
    const before = st.editBefore
    st.editBefore = null
    this.pushHistory(before)
  }

  undoAction(): void {
    const st = this.state
    this.commitEdit()
    if (st.undo.length === 0) return
    st.redo.push(this.snapshot())
    const snap = st.undo.pop()!
    this.restore(snap)
    this.syncUndoRedoButtons()
    this.toast(this.t('toast.undo'))
  }

  redoAction(): void {
    const st = this.state
    this.commitEdit()
    if (st.redo.length === 0) return
    st.undo.push(this.snapshot())
    const snap = st.redo.pop()!
    this.restore(snap)
    this.syncUndoRedoButtons()
    this.toast(this.t('toast.redo'))
  }

  private restore(snap: string): void {
    const st = this.state
    let parsed: unknown
    try {
      parsed = JSON.parse(snap)
    } catch {
      this.toast(this.t('toast.historyCorrupt'))
      return
    }
    st.doc = normalizeDoc(parsed, st.lang)
    if (st.sourceByDoc.has(snap)) {
      st.source = st.sourceByDoc.get(snap) ?? null
      st.sourcePersisted = false
    }
    this.localizeDoc()
    const ids = new Set(st.doc!.shapes.map((s) => s.id))
    st.selectedIds = st.selectedIds.filter((id) => ids.has(id))
    if (st.selectedId && !ids.has(st.selectedId)) st.selectedId = st.selectedIds[st.selectedIds.length - 1] ?? null
    if (st.selectedIds.length !== 1) st.selectedCmdId = null
    else if (this.singleSelected()?.type === 'path') {
      const path = this.singleSelected() as Shape & { type: 'path' }
      if (st.selectedCmdId && !path.commands.some((c) => c.id === st.selectedCmdId)) {
        st.selectedCmdId = this.lastNonZ(path)?.id ?? null
      }
    }
    this.syncDocTitleInput()
    this.fullRefresh()
    this.scheduleSave()
  }

  syncUndoRedoButtons(): void {
    const st = this.state
    ;(this.el('undoBtn') as HTMLButtonElement).disabled = st.undo.length === 0
    ;(this.el('redoBtn') as HTMLButtonElement).disabled = st.redo.length === 0
  }

  setSaveStatus(status: 'saved' | 'saving' | 'unsaved'): void {
    const st = this.state
    st.saveStatus = status
    this.el('saveState').textContent = this.t(`save.${status}`)
    this.el('saveState').classList.toggle('saving', status === 'saving')
    this.el('saveState').classList.toggle('error', status === 'unsaved')
  }

  scheduleSave(): void {
    const st = this.state
    st.starter = false
    this.setSaveStatus('saving')
    if (st.saveTimer) clearTimeout(st.saveTimer)
    st.saveTimer = setTimeout(() => void this.saveNow(), SAVE_DEBOUNCE_MS)
  }

  /** 落盘顺序与单文件版一致：doc 失败就到此为止；source 失败只翻 sourcePersisted，不拖累 doc */
  async saveNow(): Promise<void> {
    const st = this.state
    if (st.saveTimer) {
      clearTimeout(st.saveTimer)
      st.saveTimer = null
    }
    if (!st.doc) return
    try {
      this.store.setItem(STORE_KEY_DOC, JSON.stringify(st.doc))
      await this.store.flush()
    } catch {
      this.setSaveStatus('unsaved')
      return
    }
    try {
      if (st.source) {
        if (!st.sourcePersisted) {
          this.persistSource()
          st.sourcePersisted = true
        }
      } else {
        this.store.removeItem(STORE_KEY_SOURCE)
      }
      await this.store.flush()
    } catch {
      st.sourcePersisted = false
      try {
        this.store.removeItem(STORE_KEY_SOURCE)
      } catch {
        /* 落盘失败不回头改 doc 的状态 */
      }
    }
    this.setSaveStatus('saved')
  }

  private persistSource(): void {
    const st = this.state
    if (!st.source) return
    const serialized = {
      svg: new XMLSerializer().serializeToString(st.source.doc),
      entries: [...st.source.entries.entries()]
    }
    this.store.setItem(STORE_KEY_SOURCE, JSON.stringify(serialized))
  }

  loadDocFromStore(): Doc | null {
    const raw = this.store.getItem(STORE_KEY_DOC)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || !Array.isArray(parsed.shapes)) return null
      return normalizeDoc(parsed, this.state.lang)
    } catch {
      return null
    }
  }

  /* ================= 桌布持久化 ================= */

  loadUnderlayFromStore(): Underlay | null {
    const raw = this.store.getItem(STORE_KEY_UNDERLAY)
    if (!raw) return null
    try {
      return normalizeUnderlay(JSON.parse(raw), this.state.lang)
    } catch {
      return null
    }
  }

  scheduleUnderlaySave(): void {
    const st = this.state
    if (st.underlaySaveTimer) clearTimeout(st.underlaySaveTimer)
    st.underlaySaveTimer = setTimeout(() => void this.persistUnderlayNow(), UNDERLAY_SAVE_DEBOUNCE_MS)
  }

  /** 两道"较大"闸量的是字符数：dataURL 串与整份 JSON。失败只提示一次，会话内照常用 */
  async persistUnderlayNow(): Promise<void> {
    const st = this.state
    if (st.underlaySaveTimer) {
      clearTimeout(st.underlaySaveTimer)
      st.underlaySaveTimer = null
    }
    try {
      if (!st.underlay) {
        this.store.removeItem(STORE_KEY_UNDERLAY)
        await this.store.flush()
      } else {
        if (st.underlay.src.length > UNDERLAY_SRC_MAX) throw new Error('underlay dataURL too large')
        const json = JSON.stringify(st.underlay)
        if (json.length > UNDERLAY_JSON_MAX) throw new Error('underlay json too large')
        this.store.setItem(STORE_KEY_UNDERLAY, json)
        await this.store.flush()
      }
      const wasFailing = st.underlayPersistFailed
      st.underlayWarned = false
      st.underlayPersistFailed = false
      if (wasFailing) this.renderUnderlayPanel()
    } catch {
      try {
        this.store.removeItem(STORE_KEY_UNDERLAY)
      } catch {
        /* 已经进不了盘，没什么可回收 */
      }
      st.underlayPersistFailed = !!st.underlay
      if (!st.underlayWarned && st.underlay) {
        st.underlayWarned = true
        this.toast(this.t('toast.underlayLarge'))
      }
      this.renderUnderlayPanel()
    }
  }

  /* ================= 最近字体（文件版） ================= */

  loadRecentFonts(): RecentFont[] {
    const raw = this.store.getItem(STORE_KEY_RECENT_FONTS)
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(
          (e) =>
            e &&
            typeof e.postscriptName === 'string' &&
            e.postscriptName &&
            typeof e.file === 'string' &&
            e.file
        )
        .slice(0, RECENT_FONTS_MAX)
        .map(
          (e) =>
            ({
              postscriptName: String(e.postscriptName),
              family: typeof e.family === 'string' ? e.family : '',
              style: typeof e.style === 'string' ? e.style : '',
              file: String(e.file)
            }) satisfies RecentFont
        )
    } catch {
      return []
    }
  }

  pushRecentFont(entry: RecentFont): RecentFont[] {
    const list = [entry, ...this.state.recentFonts.filter((r) => r.postscriptName !== entry.postscriptName)].slice(
      0,
      RECENT_FONTS_MAX
    )
    this.state.recentFonts = list
    this.store.setItem(STORE_KEY_RECENT_FONTS, JSON.stringify(list))
    void this.store.flush().catch(() => undefined)
    return list
  }

  /* ================= 小工具（供各分段用） ================= */

  escapeHtml(v: unknown): string {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }

  deepClone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T
  }

  toast(text: string): void {
    const st = this.state
    this.el('toast').textContent = text
    this.el('toast').classList.add('show')
    if (st.toastTimer) clearTimeout(st.toastTimer)
    st.toastTimer = setTimeout(() => this.el('toast').classList.remove('show'), 1900)
  }

  isHexColor(v: unknown): v is string {
    return isHexColor(v)
  }

  dispose(): void {
    const st = this.state
    for (const key of ['editTimer', 'saveTimer', 'toastTimer', 'tipTimer', 'underlaySaveTimer'] as const) {
      if (st[key]) clearTimeout(st[key] as ReturnType<typeof setTimeout>)
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.abortController.abort()
  }

  /** 供后续分段注册的窗口级监听统一挂 signal，dispose 一次摘干净 */
  get win(): Window {
    return window
  }

  get listenOpts(): { signal: AbortSignal } {
    return { signal: this.abortController.signal }
  }

  /* ================= 语言：模式、刷新与名称本地化 ================= */

  readLangMode(): 'auto' | 'zh' | 'en' {
    const v = this.store.getItem(STORE_KEY_LANG)
    return v === 'zh' || v === 'en' ? v : 'auto'
  }

  resolveLang(mode: 'auto' | 'zh' | 'en'): Lang {
    if (mode === 'zh' || mode === 'en') return mode
    const nav = globalThis.navigator as Navigator | undefined
    const list = nav ? (nav.languages && nav.languages.length ? Array.from(nav.languages) : nav.language ? [nav.language] : []) : []
    return pickLang(list)
  }

  setLang(mode: 'auto' | 'zh' | 'en', opts: { persist?: boolean } = {}): void {
    const st = this.state
    st.langMode = mode === 'zh' || mode === 'en' ? mode : 'auto'
    st.lang = this.resolveLang(st.langMode)
    if (opts.persist !== false) {
      if (st.langMode === 'auto') this.store.removeItem(STORE_KEY_LANG)
      else this.store.setItem(STORE_KEY_LANG, st.langMode)
      void this.store.flush().catch(() => undefined)
    }
    this.applyLanguage()
    const renamed = this.localizeDoc()
    this.syncDocTitleInput()
    if (!this.el('canvasModal').hidden) this.el('canvasSizeError').textContent = ''
    this.fullRefresh()
    if (renamed) this.scheduleSave()
  }

  /** 双语刷新：静态骨架按 data-i18n 三族换词，shape-btn 的 title 现拼 */
  applyLanguage(): void {
    const st = this.state
    document.documentElement.lang = st.lang === 'zh' ? 'zh-CN' : 'en'
    for (const el of Array.from(this.host.querySelectorAll('[data-i18n]'))) {
      el.textContent = this.t(el.getAttribute('data-i18n')!)
    }
    for (const el of Array.from(this.host.querySelectorAll('[data-i18n-title]'))) {
      el.setAttribute('title', this.t(el.getAttribute('data-i18n-title')!))
    }
    for (const el of Array.from(this.host.querySelectorAll('[data-i18n-aria]'))) {
      el.setAttribute('aria-label', this.t(el.getAttribute('data-i18n-aria')!))
    }
    for (const btn of Array.from(this.host.querySelectorAll<HTMLElement>('.shape-btn'))) {
      const type = btn.dataset.add as ShapeType | undefined
      if (!type || !SHAPE_TYPES.includes(type)) continue
      const label = st.lang === 'en' ? this.t(`shape.${type}`).toLowerCase() : this.t(`shape.${type}`)
      btn.title = this.t('shape.addTitle', { label, key: SHAPE_HOTKEYS[type] })
    }
    const select = this.el('langSelect') as HTMLSelectElement
    select.value = st.langMode
    const auto = select.querySelector('option[value="auto"]')
    if (auto) auto.textContent = this.t('lang.auto')
    select.setAttribute('aria-label', this.t('lang.label'))
    this.setSaveStatus(st.saveStatus)
  }

  /**
   * 默认名烧的是"写下那一刻的语言"。切换语言时按双语候选表认出来再改写；
   * 用户自定义名匹配不上，原样不动。" 副本"/" copy" 后缀先剥后贴（会累积——原行为）。
   */
  private static DEFAULT_NAME_KEYS: Array<{ key: string; extras: string[] }> = [
    { key: 'name.roundedRect', extras: [] },
    { key: 'name.bezierCurve', extras: ['Bezier curve'] },
    { key: 'name.rect', extras: [] },
    { key: 'name.ellipse', extras: [] },
    { key: 'name.circle', extras: [] },
    { key: 'name.polygon', extras: [] },
    { key: 'name.line', extras: [] },
    { key: 'name.text', extras: [] },
    { key: 'name.path', extras: [] }
  ]

  localizeDocName(raw: string): string {
    const st = this.state
    const copySuffixes = [String(translate('zh', 'name.copySuffix')), String(translate('en', 'name.copySuffix'))]
    let name = raw
    let suffix = ''
    for (const s of copySuffixes) {
      if (name.endsWith(s)) {
        suffix = s
        name = name.slice(0, -s.length)
        break
      }
    }
    for (const { key, extras } of AlbedoWorkspace.DEFAULT_NAME_KEYS) {
      const candidates = [String(translate('zh', key)), String(translate('en', key)), ...extras]
      for (const c of candidates) {
        const re = new RegExp(`^${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)$`, 'i')
        const m = re.exec(name)
        if (m) return `${String(translate(st.lang, key))} ${m[1]}${suffix}`
      }
    }
    for (const key of ['boolean.unite', 'boolean.subtract', 'boolean.intersect', 'boolean.exclude']) {
      const candidates = [String(translate('zh', key)), String(translate('en', key))]
      if (candidates.includes(name)) return String(translate(st.lang, key)) + suffix
    }
    return raw
  }

  /** 文档名 / 每个形状名 / 桌布名逐条本地化；返回是否有改动（调用方据此标脏） */
  localizeDoc(): boolean {
    const st = this.state
    let touched = false
    const untitledCandidates = [String(translate('zh', 'doc.untitled')), String(translate('en', 'doc.untitled'))]
    if (st.doc && untitledCandidates.includes(st.doc.name)) {
      const want = String(translate(st.lang, 'doc.untitled'))
      if (st.doc.name !== want) {
        st.doc.name = want
        touched = true
      }
    }
    if (st.doc) {
      for (const shape of st.doc.shapes) {
        const next = this.localizeDocName(shape.name)
        if (next !== shape.name) {
          shape.name = next
          touched = true
        }
      }
    }
    if (st.underlay) {
      const defaults = [String(translate('zh', 'underlay.defaultName')), String(translate('en', 'underlay.defaultName'))]
      if (defaults.includes(st.underlay.name)) {
        const want = String(translate(st.lang, 'underlay.defaultName'))
        if (st.underlay.name !== want) {
          st.underlay.name = want
          touched = true
        }
      }
    }
    return touched
  }

  syncDocTitleInput(): void {
    const st = this.state
    const input = this.el('docTitle') as HTMLInputElement
    input.value = st.doc?.name?.trim() ? st.doc.name : this.t('doc.untitled')
  }

  /* ================= 选择与形状取用 ================= */

  findShape(id: string | null): Shape | null {
    const st = this.state
    if (!st.doc || !id) return null
    return st.doc.shapes.find((s) => s.id === id) ?? null
  }

  selectedShapes(): Shape[] {
    const st = this.state
    if (!st.doc) return []
    return st.doc.shapes.filter((s) => st.selectedIds.includes(s.id))
  }

  singleSelected(): Shape | null {
    const st = this.state
    return st.selectedIds.length === 1 ? this.findShape(st.selectedIds[0]!) : null
  }

  lastNonZ(path: { commands: PathCommand[] }): PathCommand | null {
    for (let i = path.commands.length - 1; i >= 0; i -= 1) {
      if (path.commands[i]!.type !== 'Z') return path.commands[i]!
    }
    return null
  }

  preferredCommand(path: Shape): PathCommand | null {
    if (path.type !== 'path') return null
    return path.commands.find((c) => c.type === 'C' || c.type === 'Q') ?? this.lastNonZ(path)
  }

  setSelectedIds(ids: string[], anchor: string | null = null): void {
    const st = this.state
    if (!st.doc) return
    const wanted = new Set(ids)
    st.selectedIds = st.doc.shapes.filter((s) => wanted.has(s.id)).map((s) => s.id)
    st.selectedId = st.selectedIds.includes(anchor ?? '') ? anchor : st.selectedIds[st.selectedIds.length - 1] ?? null
    if (st.selectedIds.length !== 1) {
      st.selectedCmdId = null
      st.pathEdit = true
    }
  }

  selectShape(
    id: string | null | undefined,
    opts: { additive?: boolean; toggle?: boolean; keepPathEdit?: boolean; scrollLayer?: boolean } = {}
  ): void {
    const st = this.state
    const target = id && this.findShape(id) ? id : null
    st.snapGuides = []
    if (target) st.underlayAdjust = false
    if (opts.additive || opts.toggle) {
      if (!target) return this.setSelectedIds([])
      const set = new Set(st.selectedIds)
      let anchor: string | null = target
      if (set.has(target)) {
        set.delete(target)
        anchor = null
      } else set.add(target)
      this.setSelectedIds([...set], anchor)
    } else if (!target) {
      this.setSelectedIds([])
    } else {
      this.setSelectedIds([target], target)
    }
    const single = this.singleSelected()
    if (single && single.type === 'path') {
      if (!opts.keepPathEdit) st.pathEdit = true
      if (st.selectedCmdId && !single.commands.some((c) => c.id === st.selectedCmdId)) st.selectedCmdId = null
      if (!st.selectedCmdId) st.selectedCmdId = this.preferredCommand(single)?.id ?? null
    } else {
      st.selectedCmdId = null
    }
    this.renderLayerList()
    this.renderInspector()
    this.renderInspectorRail()
    this.renderOverlay()
    this.renderUnderlayPanel()
    this.renderStatus()
    if (opts.scrollLayer && st.selectedId) {
      const row = this.el('layers').querySelector(`[data-layer-id="${st.selectedId}"]`)
      if (row && 'scrollIntoView' in row) (row as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }

  /** 框选/全选用：不做起手、不动 underlayAdjust、pathEdit 保持，只把命令高亮落到首选 */
  setSelection(ids: string[], anchor: string | null = null): void {
    const st = this.state
    this.setSelectedIds(ids, anchor)
    const single = this.singleSelected()
    st.selectedCmdId = single && single.type === 'path' ? this.preferredCommand(single)?.id ?? null : null
    this.fullRefresh()
  }

  selectCommand(cmdId: string, scroll = false): void {
    const st = this.state
    const single = this.singleSelected()
    if (!single || single.type !== 'path') return
    if (!single.commands.some((c) => c.id === cmdId)) return
    st.selectedCmdId = cmdId
    for (const card of Array.from(this.el('inspector').querySelectorAll<HTMLElement>('.cmd-card'))) {
      card.classList.toggle('selected', card.dataset.cmdCard === cmdId)
    }
    if (scroll) {
      const card = this.el('inspector').querySelector(`[data-cmd-card="${cmdId}"]`)
      if (card && 'scrollIntoView' in card) (card as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
    this.renderOverlay()
    this.renderStatus()
    this.updatePathTip()
  }
  /* ================= 舞台渲染 ================= */

  private static SVG_NS = 'http://www.w3.org/2000/svg'

  svgEl(tag: string, attrs: Record<string, string | number | null | undefined>    ): Element {
    const el = document.createElementNS(AlbedoWorkspace.SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) {
      if (v !== null && v !== undefined) el.setAttribute(k, String(v))
    }
    return el
  }

  /** 覆盖层"屏幕尺寸恒定"的三件套：线宽换算、点变换、uiScale 读数 */
  uiScaleOf(): number {
    const v = this.state.uiScale
    return Number.isFinite(v) && v > 0 ? v : 1
  }

  scaleLen(px: number): number {
    return px * this.uiScaleOf()
  }

  nodeTransform(x: number, y: number): string {
    const s = Math.round(this.uiScaleOf() * 1e5) / 1e5
    return `translate(${fmt2(x)} ${fmt2(y)}) scale(${s})`
  }

  /** 形状的绘制属性（画布视图侧，与导出侧的样式串不是一份） */
  paintAttrs(shape: Shape): Record<string, string | number> {
    const fill = shape.type === 'line' ? 'none' : shape.fill
    const stroke = shape.stroke === 'none' || shape.strokeWidth === 0 ? 'none' : shape.stroke
    return {
      fill,
      stroke,
      'stroke-width': shape.strokeWidth,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      opacity: shape.opacity
    }
  }

  /** 一个形状 = 一个 <g class="shape" data-id>；直线与路径多带一条透明命中线（max(16, w+12)） */
  renderShapeEl(shape: Shape    ): Element {
    const g = this.svgEl('g', { class: 'shape', 'data-id': shape.id })
    const paint = this.paintAttrs(shape)
    const hitWidth = Math.max(16, shape.strokeWidth + 12)
    switch (shape.type) {
      case 'rect':
        g.appendChild(
          this.svgEl('rect', {
            ...paint,
            x: shape.x,
            y: shape.y,
            width: shape.w,
            height: shape.h,
            rx: Math.min(Math.max(shape.rx, 0), Math.min(shape.w, shape.h) / 2)
          })
        )
        break
      case 'ellipse':
        g.appendChild(this.svgEl('ellipse', { ...paint, cx: shape.cx, cy: shape.cy, rx: shape.rx, ry: shape.ry }))
        break
      case 'circle':
        g.appendChild(this.svgEl('circle', { ...paint, cx: shape.cx, cy: shape.cy, r: shape.r }))
        break
      case 'polygon':
        g.appendChild(
          this.svgEl('polygon', {
            ...paint,
            points: shape.points.map((p) => `${fmt2(p.x)},${fmt2(p.y)}`).join(' ')
          })
        )
        break
      case 'line':
        g.appendChild(
          this.svgEl('line', {
            class: 'shape-hit',
            x1: shape.x1,
            y1: shape.y1,
            x2: shape.x2,
            y2: shape.y2,
            stroke: 'transparent',
            'stroke-width': hitWidth,
            'stroke-linecap': 'round'
          })
        )
        g.appendChild(
          this.svgEl('line', { ...paint, x1: shape.x1, y1: shape.y1, x2: shape.x2, y2: shape.y2 })
        )
        break
      case 'text': {
        const entry = shape.fontFamily ? this.state.fonts.get(shape.fontFamily) : null
        const font = entry ? (entry.font as TextFontLike) : null
        g.appendChild(
          this.svgEl('text', {
            ...paint,
            x: shape.x,
            y: textBaselineY(shape, font),
            'font-family': entry ? entry.cssFamily : 'sans-serif',
            'font-size': shape.fontSize
          })
        )
        g.lastChild!.textContent = shape.text || ' '
        break
      }
      case 'path': {
        const d = commandsToPath(shape.commands)
        g.appendChild(this.svgEl('path', { class: 'shape-hit', d, stroke: 'transparent', 'stroke-width': hitWidth, fill: 'none' }))
        const rule = shape.fillRule === 'evenodd' ? { 'fill-rule': 'evenodd' } : {}
        g.appendChild(this.svgEl('path', { ...paint, ...rule, d }))
        break
      }
    }
    return g
  }

  syncCanvasGeometry(): void {
    const st = this.state
    if (!st.doc) return
    const { width, height } = st.doc
    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    this.svg.setAttribute('aria-label', this.t('canvas.stageAria', { size: `${width} × ${height}` }))
    const bg = this.el('canvasBg')
    bg.setAttribute('width', String(width))
    bg.setAttribute('height', String(height))
    this.el('canvasSizeLabel').textContent = `${width} × ${height}`
    this.el('canvasSizeBtn').setAttribute('title', this.t('canvas.changeSizeCurrent', { size: `${width} × ${height}` }))
    const stat = this.el('inspector').querySelector('#docSizeStat')
    if (stat) stat.textContent = `${width} × ${height}`
  }

  /** 网格是 defs 里的一张 pattern：两条边拼整网，vector-effect 让线宽不随缩放变 */
  renderGrid(): void {
    const st = this.state
    const defs = this.el('stageDefs')
    const layer = this.el('gridLayer')
    defs.textContent = ''
    layer.textContent = ''
    const size = Number(st.grid.size) || 8
    if (!st.grid.visible || size <= 0) return
    const pattern = this.svgEl('pattern', { id: 'gridPattern', width: size, height: size, patternUnits: 'userSpaceOnUse' })
    pattern.appendChild(
      this.svgEl('path', {
        d: `M ${size} 0 L 0 0 L 0 ${size}`,
        stroke: '#171a1f',
        'stroke-width': 1,
        'vector-effect': 'non-scaling-stroke',
        fill: 'none',
        opacity: 0.13
      })
    )
    defs.appendChild(pattern)
    if (st.doc) {
      layer.appendChild(
        this.svgEl('rect', { x: 0, y: 0, width: st.doc.width, height: st.doc.height, fill: 'url(#gridPattern)' })
      )
    }
  }

  /** 桌布只画 image 本体；调整态的框与手柄在 overlay，拖动时只 setAttribute 不重建 */
  renderUnderlayLayer(): void {
    const st = this.state
    const layer = this.el('underlayLayer')
    layer.textContent = ''
    if (!st.underlay || !st.underlay.visible) return
    layer.appendChild(
      this.svgEl('image', {
        href: st.underlay.src,
        x: st.underlay.x,
        y: st.underlay.y,
        width: st.underlay.w,
        height: st.underlay.h,
        opacity: st.underlay.opacity,
        preserveAspectRatio: 'none',
        'aria-hidden': 'true'
      })
    )
  }

  updateUnderlayImage(): void {
    const st = this.state
    const img = this.el('underlayLayer').querySelector('image')
    if (!st.underlay || !st.underlay.visible || !img) {
      this.renderUnderlayLayer()
      return
    }
    img.setAttribute('x', String(st.underlay.x))
    img.setAttribute('y', String(st.underlay.y))
    img.setAttribute('width', String(st.underlay.w))
    img.setAttribute('height', String(st.underlay.h))
    img.setAttribute('opacity', String(st.underlay.opacity))
  }

  renderShapeLayer(): void {
    const st = this.state
    if (!st.doc) return
    this.syncCanvasGeometry()
    this.el('canvasBg').setAttribute('fill', st.doc.background === 'none' ? 'transparent' : st.doc.background)
    const frag = document.createDocumentFragment()
    for (const shape of st.doc.shapes) frag.appendChild(this.renderShapeEl(shape))
    this.el('shapeLayer').replaceChildren(frag)
    this.updateEmptyCanvasHint()
    this.renderOverlay()
  }

  /** 空画布提示：有图形或有可见桌布都收起 */
  updateEmptyCanvasHint(): void {
    const st = this.state
    const hasContent = (st.doc?.shapes.length ?? 0) > 0 || Boolean(st.underlay?.visible)
    this.el('emptyCanvas').classList.toggle('hidden', hasContent)
  }

  /* ================= 覆盖层 ================= */

  renderOverlay(): void {
    const st = this.state
    const overlay = this.el('overlay')
    overlay.textContent = ''
    const sel = this.selectedShapes()
    if (sel.length === 1 && sel[0]!.type === 'path' && st.pathEdit) this.drawPathNodes(sel[0]!)
    else if (sel.length === 1) this.drawShapeSelection(sel[0]!)
    else if (sel.length > 1) this.drawMultiSelection(sel)
    else if (st.underlayAdjust && st.underlay?.visible) this.drawUnderlayHandles()
    if (st.marquee) this.drawMarquee()
    this.drawSnapGuides()
    this.updatePathTip()
  }

  private handleCursor(key: string): string {
    return { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' }[key] ?? 'default'
  }

  /** 选中框：虚线 box + 8 向手柄（circle 只给 4 角）+ 尺寸标签胶囊 */
  drawSelectionBox(box: Box, labelText: string, handleKeys: string[] | null): void {
    const overlay = this.el('overlay')
    overlay.appendChild(
      this.svgEl('rect', {
        class: 'selection-box',
        x: box.x,
        y: box.y,
        width: box.w,
        height: box.h,
        'stroke-width': this.scaleLen(1.2),
        'stroke-dasharray': `${this.scaleLen(4)} ${this.scaleLen(3)}`
      })
    )
    const all = ['nw', 'n', 'ne', 'e', 's', 'se', 'sw', 'w']
    const keys = handleKeys ?? all
    for (const key of all) {
      if (!keys.includes(key)) continue
      const hx = key.includes('w') ? box.x : key.includes('e') ? box.x + box.w : box.x + box.w / 2
      const hy = key.includes('n') ? box.y : key.includes('s') ? box.y + box.h : box.y + box.h / 2
      const g = this.svgEl('g', {
        class: 'sel-handle-g',
        'data-handle': key,
        style: `cursor:${this.handleCursor(key)}-resize`,
        transform: this.nodeTransform(hx, hy)
      })
      g.appendChild(this.svgEl('circle', { class: 'handle-hit', cx: 0, cy: 0, r: 11 }))
      g.appendChild(this.svgEl('rect', { class: 'handle-visual', x: -4, y: -4, width: 8, height: 8, rx: 1.4 }))
      overlay.appendChild(g)
    }
    if (labelText) this.drawSelectionLabel(box, labelText)
  }

  private drawSelectionLabel(box: Box, text: string): void {
    const overlay = this.el('overlay')
    const st = this.state
    const doc = st.doc!
    const w = Math.max(64, text.length * 6.2 + 16)
    const h = 18
    const s = this.uiScaleOf()
    let lx = box.x + box.w / 2 - w / 2
    let ly = box.y - 25 * s
    if (ly < 4 * s) ly = box.y + box.h + 8 * s
    if (ly + h * s > doc.height - 18 * s) ly = doc.height - 18 * s - h * s
    lx = Math.min(Math.max(0, lx), doc.width - w * s)
    const g = this.svgEl('g', { class: 'selection-label', transform: `translate(${lx} ${ly}) scale(${Math.round(s * 1e5) / 1e5})` })
    g.appendChild(this.svgEl('rect', { class: 'sel-size-bg', x: 0, y: 0, width: w, height: h, rx: 4 }))
    const t = this.svgEl('text', { class: 'sel-size-text', x: w / 2, y: 12, 'text-anchor': 'middle' })
    t.textContent = text
    g.appendChild(t)
    overlay.appendChild(g)
  }

  drawShapeSelection(shape: Shape): void {
    const box = this.shapeBox(shape)
    const st = this.state
    if (shape.type === 'circle') {
      this.drawSelectionBox(box, `R ${Math.round(shape.r)}`, ['nw', 'ne', 'se', 'sw'])
    } else {
      this.drawSelectionBox(box, `${Math.round(box.w)} × ${Math.round(box.h)}`, null)
    }
    if (st.doc) void st.doc // 保持调用形参一致
  }

  drawMultiSelection(list: Shape[]): void {
    const box = unionBoxes(list.map((s) => this.shapeBox(s))) ?? { x: 0, y: 0, w: 0, h: 0 }
    const label = this.tf('selection.multiLabel', list.length, { w: Math.round(box.w), h: Math.round(box.h) })
    this.drawSelectionBox(box, label, null)
  }

  drawMarquee(): void {
    const m = this.state.marquee
    if (!m) return
    this.el('overlay').appendChild(
      this.svgEl('rect', {
        class: 'marquee',
        x: m.x,
        y: m.y,
        width: m.w,
        height: m.h,
        'stroke-width': this.scaleLen(1),
        'stroke-dasharray': `${this.scaleLen(3)} ${this.scaleLen(3)}`
      })
    )
  }

  drawSnapGuides(): void {
    const st = this.state
    if (!st.doc) return
    for (const guide of st.snapGuides) {
      const attrs =
        guide.axis === 'x'
          ? { x1: guide.value, y1: 0, x2: guide.value, y2: st.doc.height }
          : { x1: 0, y1: guide.value, x2: st.doc.width, y2: guide.value }
      this.el('overlay').appendChild(
        this.svgEl('line', {
          class: `snap-guide ${guide.kind || 'shape'}`,
          ...attrs,
          'stroke-width': this.scaleLen(1),
          'stroke-dasharray': `${this.scaleLen(4)} ${this.scaleLen(3)}`
        })
      )
    }
  }

  /** 节点编辑覆盖层：选中段高亮、控制杆、锚点方块、控制点圆与 C1/C2/Q 标号 */
  drawPathNodes(shape: Shape): void {
    if (shape.type !== 'path') return
    const st = this.state
    const overlay = this.el('overlay')
    const g = this.svgEl('g', { class: 'path-nodes' })
    let cur: { x: number; y: number } | null = null
    let subStart: { x: number; y: number } | null = null
    const rods: Array<{ a: { x: number; y: number }; b: { x: number; y: number }; active: boolean }> = []
    const anchors: Array<{ cmd: PathCommand; point: { x: number; y: number }; active: boolean }> = []
    const controls: Array<{ cmd: PathCommand; part: 'c1' | 'c2' | 'c'; point: { x: number; y: number }; active: boolean }> = []
    for (const cmd of shape.commands) {
      const active = cmd.id === st.selectedCmdId
      if (cmd.type === 'M') {
        cur = { x: cmd.x, y: cmd.y }
        subStart = cur
        anchors.push({ cmd, point: cur, active })
      } else if (cmd.type === 'L' && cur) {
        const p = { x: cmd.x, y: cmd.y }
        if (active) {
          g.appendChild(
            this.svgEl('path', {
              class: 'active-segment',
              'stroke-width': this.scaleLen(2.6),
              d: `M ${fmt2(cur.x)} ${fmt2(cur.y)} L ${fmt2(p.x)} ${fmt2(p.y)}`
            })
          )
        }
        anchors.push({ cmd, point: p, active })
        cur = p
      } else if (cmd.type === 'Q' && cur) {
        const c = { x: cmd.x1, y: cmd.y1 }
        const p = { x: cmd.x, y: cmd.y }
        if (active) {
          g.appendChild(
            this.svgEl('path', {
              class: 'active-segment',
              'stroke-width': this.scaleLen(2.6),
              d: `M ${fmt2(cur.x)} ${fmt2(cur.y)} Q ${fmt2(c.x)} ${fmt2(c.y)} ${fmt2(p.x)} ${fmt2(p.y)}`
            })
          )
        }
        rods.push({ a: cur, b: c, active })
        rods.push({ a: p, b: c, active })
        controls.push({ cmd, part: 'c', point: c, active })
        anchors.push({ cmd, point: p, active })
        cur = p
      } else if (cmd.type === 'C' && cur) {
        const c1 = { x: cmd.x1, y: cmd.y1 }
        const c2 = { x: cmd.x2, y: cmd.y2 }
        const p = { x: cmd.x, y: cmd.y }
        if (active) {
          g.appendChild(
            this.svgEl('path', {
              class: 'active-segment',
              'stroke-width': this.scaleLen(2.6),
              d:
                `M ${fmt2(cur.x)} ${fmt2(cur.y)} C ${fmt2(c1.x)} ${fmt2(c1.y)} ` +
                `${fmt2(c2.x)} ${fmt2(c2.y)} ${fmt2(p.x)} ${fmt2(p.y)}`
            })
          )
        }
        rods.push({ a: cur, b: c1, active })
        rods.push({ a: p, b: c2, active })
        controls.push({ cmd, part: 'c1', point: c1, active })
        controls.push({ cmd, part: 'c2', point: c2, active })
        anchors.push({ cmd, point: p, active })
        cur = p
      } else if (cmd.type === 'A' && cur) {
        const p = { x: cmd.x, y: cmd.y }
        if (active) {
          g.appendChild(
            this.svgEl('path', {
              class: 'active-segment',
              'stroke-width': this.scaleLen(2.6),
              d: commandsToPath([{ id: '', type: 'M', x: cur.x, y: cur.y } as PathCommand, cmd])
            })
          )
        }
        anchors.push({ cmd, point: p, active })
        cur = p
      } else if (cmd.type === 'Z' && subStart) {
        cur = { ...subStart }
      }
    }
    for (const rod of rods) {
      g.appendChild(
        this.svgEl('line', {
          class: 'guide-line' + (rod.active ? ' active' : ''),
          x1: rod.a.x,
          y1: rod.a.y,
          x2: rod.b.x,
          y2: rod.b.y,
          'stroke-width': this.scaleLen(rod.active ? 1.35 : 1),
          'stroke-dasharray': `${this.scaleLen(4)} ${this.scaleLen(4)}`
        })
      )
    }
    for (const a of anchors) {
      const node = this.svgEl('g', {
        class: 'node' + (a.active ? ' is-active' : ''),
        'data-node': 'anchor',
        'data-cmd': a.cmd.id,
        transform: this.nodeTransform(a.point.x, a.point.y)
      })
      node.appendChild(this.svgEl('circle', { class: 'node-hit', cx: 0, cy: 0, r: 11 }))
      node.appendChild(
        this.svgEl('rect', {
          class: 'node-anchor' + (a.active ? ' is-active' : ''),
          x: -4.2,
          y: -4.2,
          width: 8.4,
          height: 8.4,
          rx: 1
        })
      )
      g.appendChild(node)
    }
    for (const c of controls) {
      const node = this.svgEl('g', {
        class: 'node' + (c.active ? ' is-active' : ''),
        'data-node': 'control',
        'data-cmd': c.cmd.id,
        'data-part': c.part,
        transform: this.nodeTransform(c.point.x, c.point.y)
      })
      node.appendChild(this.svgEl('circle', { class: 'node-hit', cx: 0, cy: 0, r: 10 }))
      node.appendChild(
        this.svgEl('circle', { class: 'node-control' + (c.active ? ' is-active' : ''), cx: 0, cy: 0, r: 3.9 })
      )
      if (c.active) {
        const label = this.svgEl('text', { class: 'node-label', x: 7, y: -7 })
        label.textContent = c.part === 'c1' ? 'C1' : c.part === 'c2' ? 'C2' : 'Q'
        node.appendChild(label)
      }
      g.appendChild(node)
    }
    overlay.appendChild(g)
  }

  /** 桌布调整态：整块可拖、四角等比缩放、虚框与标签胶囊 */
  drawUnderlayHandles(): void {
    const st = this.state
    const u = st.underlay
    if (!u || !st.underlayAdjust || !u.visible || !st.doc) return
    const overlay = this.el('overlay')
    const s = this.uiScaleOf()
    overlay.appendChild(
      this.svgEl('rect', { class: 'underlay-hit', 'data-underlay': 'move', x: u.x, y: u.y, width: u.w, height: u.h })
    )
    overlay.appendChild(
      this.svgEl('rect', {
        class: 'underlay-frame',
        x: u.x,
        y: u.y,
        width: u.w,
        height: u.h,
        'stroke-width': this.scaleLen(1.5),
        'stroke-dasharray': `${this.scaleLen(7)} ${this.scaleLen(5)}`
      })
    )
    const lw = 126
    const lh = 18
    let ly = u.y - 5 * s
    if (ly < 0) ly = u.y + u.h + 8 * s
    ly = Math.min(Math.max(0, ly), st.doc.height - lh * s)
    const lx = Math.min(Math.max(0, u.x), st.doc.width - lw * s)
    const label = this.svgEl('g', { class: 'underlay-label', transform: `translate(${lx} ${ly}) scale(${Math.round(s * 1e5) / 1e5})` })
    label.appendChild(this.svgEl('rect', { class: 'underlay-label-bg', x: 0, y: 0, width: lw, height: lh, rx: 4 }))
    const text = this.svgEl('text', { class: 'underlay-label', x: 8, y: 12 })
    text.textContent = this.t('underlay.overlayLabel')
    label.appendChild(text)
    overlay.appendChild(label)
    const edge = 6 * s
    for (const key of ['nw', 'ne', 'se', 'sw']) {
      const rawX = key.includes('w') ? u.x : u.x + u.w
      const rawY = key.includes('n') ? u.y : u.y + u.h
      const hx = Math.min(Math.max(edge, rawX), st.doc.width - edge)
      const hy = Math.min(Math.max(edge, rawY), st.doc.height - edge)
      const g = this.svgEl('g', {
        class: 'underlay-handle-g',
        'data-underlay': key,
        style: `cursor:${this.handleCursor(key)}-resize`,
        transform: this.nodeTransform(hx, hy)
      })
      g.appendChild(this.svgEl('circle', { class: 'handle-hit', cx: 0, cy: 0, r: 12 }))
      g.appendChild(this.svgEl('rect', { class: 'underlay-handle', x: -4.2, y: -4.2, width: 8.4, height: 8.4, rx: 1.2 }))
      overlay.appendChild(g)
    }
  }

  updatePathTip(): void {
    const st = this.state
    const single = this.singleSelected()
    const show = Boolean(single && single.type === 'path' && st.pathEdit && !st.tipDismissed)
    this.el('canvasTip').classList.toggle('hidden', !show)
  }

  shapeBox(shape: Shape): Box {
    return shapeBBox(shape, (ps) => (ps ? (this.state.fonts.get(ps)?.font as TextFontLike | undefined) ?? null : null))
  }
  /* ================= 视口：布局、缩放、坐标读数 ================= */

  /**
   * 缩放不动 viewBox：改的是 artboardWrap 的 CSS 宽高（doc 单位 → 屏幕像素），
   * uiScale 由 getScreenCTM 反推（1 个屏幕像素等于多少 doc 单位）；
   * jsdom 没有 CTM 时按 wrap 宽度反推同一把尺。
   */
  layoutStage(anchor?: { x: number; y: number } | null): void {
    const st = this.state
    if (!st.doc) return
    const before = anchor ? this.clientToDoc(anchor.x, anchor.y) : null
    const body = this.el('stageBody')
    const wrap = this.el('artboardWrap')
    const pad = 64
    const availW = Math.max(80, body.clientWidth - pad * 2)
    const availH = Math.max(80, body.clientHeight - pad * 2)
    const aspect = st.doc.width / Math.max(1, st.doc.height)
    let w = Math.min(availW, 980)
    let h = w / aspect
    if (h > availH) {
      h = availH
      w = h * aspect
    }
    const z = clampZoom(st.zoom)
    w = Math.max(1, Math.floor(w * z))
    h = Math.max(1, Math.floor(h * z))
    wrap.style.width = `${w}px`
    wrap.style.height = `${h}px`
    const scale = this.currentScreenScale()
    const next = scale > 0 ? 1 / scale : st.doc.width / Math.max(1, w)
    if (Math.abs(next - st.uiScale) > 5e-4) {
      st.uiScale = next
      this.renderOverlay()
    }
    if (anchor && before) this.keepAnchor(anchor, before)
    this.syncZoomLabel()
  }

  private currentScreenScale(): number {
    const ctm = typeof this.svg.getScreenCTM === 'function' ? this.svg.getScreenCTM() : null
    return ctm && Number.isFinite(ctm.a) && ctm.a > 0 ? ctm.a : 0
  }

  /** 缩放时让 anchor 那个屏幕点下的文档位置不漂移：布局后把它挪回原屏幕坐标 */
  private keepAnchor(anchor: { x: number; y: number }, docPoint: { x: number; y: number }): void {
    if (typeof this.svg.createSVGPoint !== 'function' || typeof this.svg.getScreenCTM !== 'function') return
    const ctm = this.svg.getScreenCTM()
    if (!ctm) return
    const pt = this.svg.createSVGPoint()
    pt.x = docPoint.x
    pt.y = docPoint.y
    const after = pt.matrixTransform(ctm)
    const body = this.el('stageBody')
    body.scrollLeft += after.x - anchor.x
    body.scrollTop += after.y - anchor.y
  }

  syncZoomLabel(): void {
    const st = this.state
    this.el('zoomLabel').textContent = zoomLabel(st.zoom)
    ;(this.el('zoomOutBtn') as HTMLButtonElement).disabled = clampZoom(st.zoom) <= 0.5
    ;(this.el('zoomInBtn') as HTMLButtonElement).disabled = clampZoom(st.zoom) >= 8
  }

  setZoom(z: number, center?: { x: number; y: number }): void {
    const st = this.state
    const next = clampZoom(z)
    if (Math.abs(next - clampZoom(st.zoom)) < 1e-9) return
    st.zoom = next
    this.layoutStage(center ?? null)
  }

  zoomStep(dir: number): void {
    this.setZoom(stepZoom(this.state.zoom, dir), this.viewportCenter())
  }

  viewportCenter(): { x: number; y: number } {
    const r = this.el('stageBody').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  clientToDoc(clientX: number, clientY: number): { x: number; y: number } | null {
    if (typeof this.svg.createSVGPoint === 'function' && typeof this.svg.getScreenCTM === 'function') {
      const pt = this.svg.createSVGPoint()
      pt.x = clientX
      pt.y = clientY
      const ctm = this.svg.getScreenCTM()
      if (ctm) {
        const p = pt.matrixTransform(ctm.inverse())
        return { x: p.x, y: p.y }
      }
    }
    const r = this.svg.getBoundingClientRect()
    const doc = this.state.doc
    if (!doc || r.width <= 0 || r.height <= 0) return null
    return { x: ((clientX - r.left) / r.width) * doc.width, y: ((clientY - r.top) / r.height) * doc.height }
  }

  eventToDoc(e: { clientX: number; clientY: number }): { x: number; y: number } {
    return this.clientToDoc(e.clientX, e.clientY) ?? { x: 0, y: 0 }
  }

  renderPointerCoord(p: { x: number; y: number }): void {
    const doc = this.state.doc
    if (!doc) return
    const x = Math.round(clamp(p.x, 0, doc.width))
    const y = Math.round(clamp(p.y, 0, doc.height))
    const pad = (v: number): string => String(v).padStart(3, '0')
    this.el('coordStatus').innerHTML = `X ${pad(x)}&nbsp;&nbsp;Y ${pad(y)}`
  }

  /* ================= 状态栏 ================= */

  renderStatus(): void {
    const st = this.state
    if (!st.doc) return
    this.el('shapeStatus').textContent = this.tf('status.shapes', st.doc.shapes.length, {})
    const sel = this.selectedShapes()
    if (sel.length === 0) {
      this.el('nodeStatus').textContent = st.underlayAdjust ? this.t('status.underlayAdjusting') : this.t('status.noSelection')
    } else if (sel.length > 1) {
      const box = unionBoxes(sel.map((s) => this.shapeBox(s))) ?? { x: 0, y: 0, w: 0, h: 0 }
      this.el('nodeStatus').textContent = this.tf('status.selected', sel.length, { w: Math.round(box.w), h: Math.round(box.h) })
    } else if (sel[0]!.type === 'path' && st.pathEdit) {
      const path = sel[0]!
      if (path.type !== 'path') return
      const cmd = st.selectedCmdId ? ` · ${path.commands.find((c) => c.id === st.selectedCmdId)?.type ?? ''}` : ''
      this.el('nodeStatus').textContent = this.tf('status.path', path.commands.length, { cmd: cmd === ' · ' ? '' : cmd })
    } else {
      const shape = sel[0]!
      const box = this.shapeBox(shape)
      this.el('nodeStatus').textContent = this.t('status.shape', {
        label: this.t(`name.${shape.type}`),
        w: Math.round(box.w),
        h: Math.round(box.h)
      })
    }
  }

  syncToolbarToggles(): void {
    const st = this.state
    this.el('gridToggle').classList.toggle('is-active', st.grid.visible)
    this.el('gridToggle').setAttribute('aria-pressed', String(st.grid.visible))
    ;(this.el('gridSize') as HTMLSelectElement).value = String(st.grid.size)
    this.el('snapToggle').classList.toggle('is-active', st.snapEnabled)
    this.el('snapToggle').setAttribute('aria-pressed', String(st.snapEnabled))
    if (st.underlay) {
      this.el('underlayToggle').classList.add('has-reference')
      this.el('underlayToggle').classList.toggle('is-off', !st.underlay.visible)
      this.el('underlayToggle').title = this.t('underlay.manageTitle')
    } else {
      this.el('underlayToggle').classList.remove('has-reference', 'is-off')
      this.el('underlayToggle').title = this.t('underlay.importTitle')
    }
  }

  /** 全量刷新链（顺序沿用单文件版 fullRefresh） */
  fullRefresh(): void {
    if (!this.state.doc) return
    this.syncCanvasGeometry()
    this.el('canvasBg').setAttribute('fill', this.state.doc.background === 'none' ? 'transparent' : this.state.doc.background)
    this.renderGrid()
    this.renderUnderlayLayer()
    this.renderShapeLayer()
    this.renderLayerList()
    this.renderInspector()
    this.renderInspectorRail()
    this.renderUnderlayPanel()
    this.syncToolbarToggles()
    this.syncUndoRedoButtons()
    this.updatePathTip()
    this.layoutStage()
    this.refreshRails()
    this.renderStatus()
  }
  /* ================= rail：注册表驱动的分区导航 ================= */

  /** 分区出现规则：内容里写了哪个 data-rail-section，rail 就出现哪颗键；未在注册表的键忽略 */
  private static RAIL_SECTIONS = [
    'insert', 'layers', 'document', 'shortcuts', 'geometry', 'vertices',
    'path', 'align', 'style', 'operations', 'tips', 'position', 'display'
  ] as const

  private static RAIL_ICON_PATHS: Record<string, string> = {
    insert: '<path d="M64 28v72M28 64h72"/>',
    layers: '<path d="M64 20 16 44l48 24 48-24-48-24Z"/><path d="M16 64l48 24 48-24"/><path d="M16 84l48 24 48-24"/>',
    document: '<rect x="24" y="18" width="80" height="92" rx="10"/><path d="M40 44h48M40 64h48M40 84h30"/>',
    keyboard: '<rect x="18" y="38" width="92" height="52" rx="8"/><circle cx="37" cy="56" r="4" fill="currentColor" stroke="none"/><circle cx="57" cy="56" r="4" fill="currentColor" stroke="none"/><circle cx="77" cy="56" r="4" fill="currentColor" stroke="none"/><circle cx="97" cy="56" r="4" fill="currentColor" stroke="none"/><path d="M34 78h60"/>',
    geometry: '<rect x="18" y="18" width="54" height="54" rx="7"/><circle cx="82" cy="82" r="26"/>',
    vertices: '<path d="M24 46 64 20l40 26-12 56H36L24 46Z"/><circle cx="24" cy="46" r="6" fill="currentColor" stroke="none"/><circle cx="64" cy="20" r="6" fill="currentColor" stroke="none"/><circle cx="104" cy="46" r="6" fill="currentColor" stroke="none"/>',
    path: '<path d="M16 92c24 0 18-56 44-56s22 56 52 56"/><circle cx="44" cy="62" r="6" fill="currentColor" stroke="none"/><circle cx="82" cy="62" r="6" fill="currentColor" stroke="none"/>',
    align: '<path d="M22 20v88"/><rect x="38" y="36" width="52" height="14" rx="4"/><path d="M22 64h84"/><rect x="38" y="78" width="34" height="14" rx="4"/>',
    style: '<circle cx="64" cy="64" r="42"/><path d="M64 22a42 42 0 0 1 0 84Z" fill="currentColor" stroke="none"/>',
    operations: '<circle cx="52" cy="64" r="30"/><circle cx="76" cy="64" r="30"/>',
    tips: '<path d="M64 16a30 30 0 0 0-18 54v14h36V70a30 30 0 0 0-18-54Z"/><path d="M50 104h28"/>',
    position: '<path d="M24 44V24h20M84 24h20v20M104 84v20H84M44 104H24V84"/><path d="M64 40v48M40 64h48"/>',
    display: '<path d="M16 64c14-24 30-36 48-36s34 12 48 36c-14 24-30 36-48 36s-34-12-48-36Z"/><circle cx="64" cy="64" r="16"/>'
  }

  railIconSvg(key: string): string {
    return `<svg class="rail-icon" viewBox="0 0 128 128" width="128" height="128" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${
      AlbedoWorkspace.RAIL_ICON_PATHS[key] ?? ''
    }</svg>`
  }

  private railSectionNames(container: HTMLElement): string[] {
    const seen: string[] = []
    for (const el of Array.from(container.querySelectorAll('[data-rail-section]'))) {
      const name = el.getAttribute('data-rail-section')!
      if (AlbedoWorkspace.RAIL_SECTIONS.includes(name as (typeof AlbedoWorkspace.RAIL_SECTIONS)[number]) && !seen.includes(name)) {
        seen.push(name)
      }
    }
    return seen
  }

  private railPanelDomId(prefix: 'inspectorPanel' | 'leftPanel', section: string, repeat: number): string {
    const pascal = section.charAt(0).toUpperCase() + section.slice(1)
    return `${prefix}${pascal}${repeat > 0 ? repeat + 1 : ''}`
  }

  /** 只显示当前 tab 的分区，并补 role=tabpanel / aria-controls / labelledby */
  applyRailTab(body: HTMLElement, rail: HTMLElement, tabName: string | null, resetScroll = false): string | null {
    const sections = Array.from(body.querySelectorAll<HTMLElement>('[data-rail-section]'))
    const counts = new Map<string, number>()
    let activeFound: string | null = null
    for (const section of sections) {
      const name = section.getAttribute('data-rail-section')!
      const repeat = counts.get(name) ?? 0
      counts.set(name, repeat + 1)
      const domId = this.railPanelDomId(body === this.el('inspector') ? 'inspectorPanel' : 'leftPanel', name, repeat)
      if (!section.id) section.id = domId
      const isActive = tabName === name && activeFound === null
      if (isActive) activeFound = name
      section.hidden = !isActive
      section.setAttribute('role', 'tabpanel')
      section.setAttribute('aria-hidden', String(!isActive))
      const btn = rail.querySelector(`[data-rail-go="${name}"]`)
      if (btn) {
        section.setAttribute('aria-controls', btn.id || '')
        section.setAttribute('aria-labelledby', btn.id || '')
      }
    }
    this.syncRailButtons(rail, activeFound)
    if (resetScroll && activeFound) {
      const el = body.querySelector(`[data-rail-section="${activeFound}"]`)
      if (el && 'scrollTop' in el) body.scrollTop = 0
    }
    return activeFound
  }

  syncRailButtons(rail: HTMLElement, activeSection: string | null): void {
    for (const btn of Array.from(rail.querySelectorAll<HTMLElement>('[data-rail-go]'))) {
      const isActive = btn.dataset.railGo === activeSection
      btn.classList.toggle('active', isActive)
      btn.setAttribute('aria-selected', String(isActive))
      btn.tabIndex = isActive ? 0 : -1
    }
  }

  bindRailNav(rail: HTMLElement, onPick: (section: string) => void): void {
    rail.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('[data-rail-go]') as HTMLElement | null
      if (!btn) return
      onPick(btn.dataset.railGo!)
    }, this.listenOpts)
    rail.addEventListener('keydown', (e) => {
      const ev = e as KeyboardEvent
      const buttons = Array.from(rail.querySelectorAll<HTMLElement>('[data-rail-go]'))
      if (buttons.length === 0) return
      const index = buttons.findIndex((b) => b.dataset.railGo === this.railActive(rail))
      let next = -1
      if (ev.key === 'ArrowDown') next = (index + 1 + buttons.length) % buttons.length
      else if (ev.key === 'ArrowUp') next = (index - 1 + buttons.length) % buttons.length
      else if (ev.key === 'Home') next = 0
      else if (ev.key === 'End') next = buttons.length - 1
      else return
      ev.preventDefault()
      const btn = buttons[next]!
      onPick(btn.dataset.railGo!)
      btn.focus()
    }, this.listenOpts)
  }

  private railActive(rail: HTMLElement): string | null {
    return rail.querySelector<HTMLElement>('[data-rail-go].active')?.dataset.railGo ?? null
  }

  showLeftTab(section: string): void {
    this.state.leftTab = this.applyRailTab(this.el('leftPanelBody'), this.el('leftRail'), section) ?? section
  }

  showInspectorTab(section: string): void {
    this.state.rightTab = this.applyRailTab(this.el('inspector'), this.el('inspectorRail'), section) ?? section
  }

  /** 检查器 rail：按当前 section 集合重建按钮（tab 变了才复位滚动） */
  renderInspectorRail(): void {
    const rail = this.el('inspectorRail')
    const sections = this.railSectionNames(this.el('inspector'))
    if (sections.length === 0) {
      rail.textContent = ''
      rail.setAttribute('aria-label', this.t('nav.inspectorRailLabel'))
      this.state.rightTab = null
      return
    }
    if (!sections.includes(this.state.rightTab ?? '')) this.state.rightTab = sections[0]!
    const previous = new Set(Array.from(rail.querySelectorAll<HTMLElement>('[data-rail-go]')).map((b) => b.dataset.railGo))
    const changed = previous.size !== sections.length || sections.some((s) => !previous.has(s))
    rail.innerHTML = sections
      .map((name) => {
        const label = this.t(`nav.${name === 'shortcuts' ? 'shortcuts' : name}`)
        return `<button type="button" class="rail-btn" id="inspectorTab${name.charAt(0).toUpperCase()}${name.slice(1)}" role="tab" data-rail-go="${name}" aria-controls="inspectorPanel${name.charAt(0).toUpperCase()}${name.slice(1)}" title="${this.escapeHtml(label)}" aria-label="${this.escapeHtml(label)}">${this.railIconSvg(name)}</button>`
      })
      .join('')
    rail.setAttribute('aria-label', this.t('nav.inspectorRailLabel'))
    this.applyRailTab(this.el('inspector'), rail, this.state.rightTab, changed)
  }

  refreshRails(): void {
    this.applyRailTab(this.el('leftPanelBody'), this.el('leftRail'), this.state.leftTab)
    this.applyRailTab(this.el('inspector'), this.el('inspectorRail'), this.state.rightTab)
  }

  /* ================= 图层面板 ================= */

  renderLayerList(): void {
    const st = this.state
    if (!st.doc) return
    st.layerDrag = null
    const shapes = st.doc.shapes
    this.el('layerCount').textContent = String(shapes.length).padStart(2, '0')
    if (shapes.length === 0) {
      this.el('layers').innerHTML = `<div class="layer-empty"><strong>${this.escapeHtml(this.t('layers.emptyTitle'))}</strong>${this.escapeHtml(this.t('layers.emptyHint'))}</div>`
      return
    }
    const len = shapes.length
    const rows = shapes
      .slice()
      .reverse()
      .map((shape, v) => {
        const index = len - 1 - v
        const selected = st.selectedIds.includes(shape.id)
        const code = SHAPE_TYPE_CODE[shape.type]
        return `<div class="layer-row${selected ? ' selected' : ''}" draggable="true" data-layer-id="${shape.id}">
          <span class="layer-grip" aria-hidden="true">⋮⋮</span>
          <span class="layer-type" aria-hidden="true">${code}</span>
          <span class="layer-name">${this.escapeHtml(shape.name)}</span>
          <button class="layer-btn" data-layer-action="up" title="${this.escapeHtml(this.t('layers.up'))}" aria-label="${this.escapeHtml(this.t('layers.up'))}"${index === len - 1 ? ' disabled' : ''}>↑</button>
          <button class="layer-btn" data-layer-action="down" title="${this.escapeHtml(this.t('layers.down'))}" aria-label="${this.escapeHtml(this.t('layers.down'))}"${index === 0 ? ' disabled' : ''}>↓</button>
          <button class="layer-btn danger" data-layer-action="delete" title="${this.escapeHtml(this.t('layers.delete'))}" aria-label="${this.escapeHtml(this.t('layers.delete'))}">✕</button>
        </div>`
      })
    this.el('layers').innerHTML = rows.join('')
  }

  moveLayerBy(id: string, delta: number): void {
    const st = this.state
    if (!st.doc) return
    const shapes = st.doc.shapes
    const from = shapes.findIndex((s) => s.id === id)
    if (from < 0) return
    const to = from + delta
    if (to < 0 || to >= shapes.length) return
    this.commitEdit()
    const before = this.snapshot()
    const [item] = shapes.splice(from, 1)
    shapes.splice(to, 0, item!)
    this.pushHistory(before)
    this.renderShapeLayer()
    this.renderLayerList()
    this.scheduleSave()
  }

  moveLayerTo(dragId: string, targetId: string, insertAfter: boolean): void {
    const st = this.state
    if (!st.doc || dragId === targetId || !dragId || !targetId) return
    const before = this.snapshot()
    const shapes = st.doc.shapes
    const from = shapes.findIndex((s) => s.id === dragId)
    if (from < 0) return
    const [item] = shapes.splice(from, 1)
    const targetIndex = shapes.findIndex((s) => s.id === targetId)
    if (targetIndex < 0) {
      shapes.splice(from, 0, item!)
      return
    }
    shapes.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, item!)
    if (this.snapshot() === before) {
      this.renderLayerList()
      return
    }
    this.pushHistory(before)
    this.renderShapeLayer()
    this.renderLayerList()
    this.scheduleSave()
  }

  /* ================= 桌布浮层与面板 ================= */

  setUnderlayPopover(open: boolean): void {
    this.el('underlayPopover').hidden = !open
    this.el('underlayToggle').setAttribute('aria-expanded', String(open))
  }

  renderUnderlayPanel(): void {
    const st = this.state
    const has = Boolean(st.underlay)
    this.el('underlayEmpty').hidden = has
    this.el('underlayControls').hidden = !has
    const u = st.underlay
    if (!u) {
      const thumb = this.el('underlayThumb') as HTMLImageElement
      if (thumb.getAttribute('src')) thumb.removeAttribute('src')
      this.el('underlayHint').hidden = true
      this.el('newBtn').title = this.t('action.newTitle')
      return
    }
    const thumb = this.el('underlayThumb') as HTMLImageElement
    if (thumb.getAttribute('src') !== u.src) thumb.setAttribute('src', u.src)
    thumb.alt = u.name
    this.el('underlayName').textContent = u.name
    this.el('underlayName').title = u.name
    if (st.underlayPersistFailed) {
      this.el('underlayMeta').textContent = this.t('underlay.metaUnsaved')
      this.el('underlayMeta').title = this.t('underlay.metaUnsavedTitle')
      this.el('underlayMeta').classList.add('is-warning')
    } else {
      this.el('underlayMeta').textContent = `${Math.round(u.naturalW)} × ${Math.round(u.naturalH)} px`
      this.el('underlayMeta').removeAttribute('title')
      this.el('underlayMeta').classList.remove('is-warning')
    }
    const visibleBtn = this.el('underlayVisibleBtn')
    visibleBtn.textContent = u.visible ? this.t('underlay.visible') : this.t('underlay.hidden')
    visibleBtn.title = u.visible ? this.t('underlay.visibleTitleOn') : this.t('underlay.visibleTitleOff')
    visibleBtn.classList.toggle('is-off', !u.visible)
    visibleBtn.setAttribute('aria-pressed', String(u.visible))
    const adjustBtn = this.el('underlayAdjustBtn') as HTMLButtonElement
    adjustBtn.textContent = st.underlayAdjust ? this.t('underlay.done') : this.t('underlay.adjust')
    adjustBtn.title = st.underlayAdjust ? this.t('underlay.adjustTitleOn') : this.t('underlay.adjustTitleOff')
    adjustBtn.disabled = !u.visible
    adjustBtn.classList.toggle('active', st.underlayAdjust)
    adjustBtn.setAttribute('aria-pressed', String(st.underlayAdjust))
    this.el('underlayHint').hidden = !st.underlayAdjust
    this.el('underlayHint').textContent =
      (st.doc?.shapes.length ?? 0) > 0 ? this.t('underlay.inspectorHintMoving') : this.t('underlay.inspectorHint')
    this.el('newBtn').title = this.t('action.newKeepTitle')
  }

  /* ================= 画布尺寸模态 ================= */

  private static gcd(a: number, b: number): number {
    let x = Math.abs(Math.round(a)) || 0
    let y = Math.abs(Math.round(b)) || 0
    if (x === 0) return y || 1
    if (y === 0) return x || 1
    while (y !== 0) {
      const t = y
      y = x % y
      x = t
    }
    return x || 1
  }

  formatRatio(w: number, h: number): string {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '\u2014'
    const g = AlbedoWorkspace.gcd(w, h)
    const rw = Math.round(w) / g
    const rh = Math.round(h) / g
    if (rw <= 30 && rh <= 30) return `${rw} : ${rh}`
    return `${(w / h).toFixed(2)} : 1`
  }

  syncCanvasModal(): void {
    const wv = Number((this.el('canvasWidthInput') as HTMLInputElement).value)
    const hv = Number((this.el('canvasHeightInput') as HTMLInputElement).value)
    this.el('canvasRatioChip').textContent = this.formatRatio(wv, hv)
    const raw = `${(this.el('canvasWidthInput') as HTMLInputElement).value},${(this.el('canvasHeightInput') as HTMLInputElement).value}`
    for (const preset of Array.from(this.host.querySelectorAll<HTMLElement>('.size-preset'))) {
      preset.classList.toggle('active', preset.dataset.preset === raw)
    }
    this.el('canvasSizeError').textContent = ''
  }

  openCanvasModal(trigger: HTMLElement | null): void {
    const st = this.state
    if (!st.doc) return
    st.canvasTrigger = trigger ?? (document.activeElement as HTMLElement | null)
    ;(this.el('canvasWidthInput') as HTMLInputElement).value = String(st.doc.width)
    ;(this.el('canvasHeightInput') as HTMLInputElement).value = String(st.doc.height)
    this.el('canvasSizeError').textContent = ''
    this.syncCanvasModal()
    this.el('canvasModal').hidden = false
    requestAnimationFrame(() => {
      const input = this.el('canvasWidthInput') as HTMLInputElement
      input.focus()
      input.select()
    })
  }

  closeCanvasModal(): void {
    const st = this.state
    if (this.el('canvasModal').hidden) return
    this.el('canvasModal').hidden = true
    const trigger = st.canvasTrigger
    if (trigger && document.contains(trigger) && 'focus' in trigger) {
      requestAnimationFrame(() => (trigger as HTMLElement).focus({ preventScroll: true }))
    }
    st.canvasTrigger = null
  }

  applyCanvasSize(): void {
    const st = this.state
    if (!st.doc) return
    const wRaw = String((this.el('canvasWidthInput') as HTMLInputElement).value).trim()
    const hRaw = String((this.el('canvasHeightInput') as HTMLInputElement).value).trim()
    if (!wRaw || !hRaw) {
      this.el('canvasSizeError').textContent = this.t('modal.required')
      return
    }
    const wNum = Number(wRaw)
    const hNum = Number(hRaw)
    if (!Number.isFinite(wNum) || !Number.isFinite(hNum)) {
      this.el('canvasSizeError').textContent = this.t('modal.invalid')
      return
    }
    const w = Math.round(wNum)
    const h = Math.round(hNum)
    if (w < 64 || w > 10000 || h < 64 || h > 10000) {
      this.el('canvasSizeError').textContent = this.t('modal.range', { min: 64, max: 10000 })
      return
    }
    if (w === st.doc.width && h === st.doc.height) {
      this.closeCanvasModal()
      return
    }
    this.commitEdit()
    const before = this.snapshot()
    st.doc.width = w
    st.doc.height = h
    this.pushHistory(before)
    this.closeCanvasModal()
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.canvasResized', { w, h }))
  }

  /* ================= 桌布动作 ================= */

  setUnderlayAdjust(on: boolean): void {
    const st = this.state
    if (!st.underlay) return
    if (on && !st.underlay.visible) {
      this.toast(this.t('toast.showUnderlay'))
      return
    }
    st.underlayAdjust = on
    if (on) this.setSelectedIds([])
    this.fullRefresh()
  }

  fitUnderlay(mode: 'contain' | 'fill'): void {
    const st = this.state
    if (!st.underlay || !st.doc) return
    const u = st.underlay
    const fn = mode === 'fill' ? Math.max : Math.min
    const scale = fn(st.doc.width / Math.max(1, u.naturalW), st.doc.height / Math.max(1, u.naturalH))
    u.w = Math.max(1, u.naturalW * scale)
    u.h = Math.max(1, u.naturalH * scale)
    u.x = (st.doc.width - u.w) / 2
    u.y = (st.doc.height - u.h) / 2
    st.underlayAdjust = true
    this.setSelectedIds([])
    this.fullRefresh()
    this.scheduleUnderlaySave()
    this.toast(this.t(mode === 'fill' ? 'toast.underlayFilled' : 'toast.underlayFitted'))
  }

  centerUnderlay(): void {
    const st = this.state
    if (!st.underlay || !st.doc) return
    st.underlay.x = (st.doc.width - st.underlay.w) / 2
    st.underlay.y = (st.doc.height - st.underlay.h) / 2
    this.updateUnderlayImage()
    this.renderOverlay()
    this.syncUnderlayInputs()
    this.scheduleUnderlaySave()
    this.toast(this.t('toast.underlayCentered'))
  }

  /** 桌布宽/高输入框：改一边强制保持原图比例，另一边跟着回填 */
  setUnderlayProp(prop: string, value: number): void {
    const st = this.state
    const u = st.underlay
    if (!u) return
    if (prop === 'w' || prop === 'h') {
      const v = Math.max(8, value)
      if (prop === 'w') {
        u.w = v
        u.h = Math.max(8, (v * u.naturalH) / Math.max(1, u.naturalW))
      } else {
        u.h = v
        u.w = Math.max(8, (v * u.naturalW) / Math.max(1, u.naturalH))
      }
    } else if (prop === 'x' || prop === 'y') {
      u[prop] = value
    }
    this.updateUnderlayImage()
    this.renderOverlay()
    this.syncUnderlayInputs()
    this.scheduleUnderlaySave()
  }

  syncUnderlayInputs(): void {
    const st = this.state
    if (!st.underlay) return
    for (const el of Array.from(this.el('inspector').querySelectorAll<HTMLInputElement>('[data-underlay-prop]'))) {
      if (document.activeElement === el) continue
      el.value = fmt2(st.underlay[el.dataset.underlayProp as 'x' | 'y' | 'w' | 'h'])
    }
  }

  nudgeUnderlay(dx: number, dy: number): void {
    const st = this.state
    if (!st.underlay) return
    st.underlay.x += dx
    st.underlay.y += dy
    this.updateUnderlayImage()
    this.renderOverlay()
    this.syncUnderlayInputs()
    this.scheduleUnderlaySave()
  }

  toggleUnderlayVisible(): void {
    const st = this.state
    if (!st.underlay) return
    st.underlay.visible = !st.underlay.visible
    if (!st.underlay.visible) st.underlayAdjust = false
    this.fullRefresh()
    this.scheduleUnderlaySave()
    this.toast(this.t(st.underlay.visible ? 'toast.underlayShown' : 'toast.underlayHidden'))
  }

  removeUnderlay(): void {
    const st = this.state
    st.underlayImportToken += 1
    st.underlay = null
    st.underlayAdjust = false
    st.underlayWarned = false
    st.underlayPersistFailed = false
    void this.persistUnderlayNow()
    this.fullRefresh()
    this.toast(this.t('toast.underlayRemoved'))
  }

  runUnderlayCommand(name: string): void {
    switch (name) {
      case 'fit':
        this.fitUnderlay('contain')
        break
      case 'fill':
        this.fitUnderlay('fill')
        break
      case 'center':
        this.centerUnderlay()
        break
      case 'done':
        this.setUnderlayAdjust(false)
        this.toast(this.t('toast.underlayFixed'))
        break
      case 'remove':
        this.removeUnderlay()
        break
      case 'replace':
        void this.pickUnderlayImage()
        break
      case 'adjust':
        this.setUnderlayAdjust(!this.state.underlayAdjust)
        break
      case 'visible':
        this.toggleUnderlayVisible()
        break
    }
  }
  /* ================= 增 / 删 / 复制 / 命令栈 ================= */

  /**
   * 加一个默认形状：尺寸随画布比例缩放（scale 钳 0.35..1.6），位置按已有形状数级联错开，
   * 填充从六色板轮着取（line/path 恒为无填充）。toast 念的是新形状的名字。
   */
  addShape(type: ShapeType | undefined): void {
    const st = this.state
    if (!st.doc || !type || !SHAPE_TYPES.includes(type)) return
    this.commitEdit()
    const before = this.snapshot()
    st.underlayAdjust = false
    const doc = st.doc
    const scale = clamp(Math.min(doc.width / 960, doc.height / 640), 0.35, 1.6)
    const cascade = (doc.shapes.length % 5) * Math.min(22, Math.min(doc.width, doc.height) * 0.035)
    const nth = doc.shapes.filter((s) => s.type === type).length + 1
    const name = defaultShapeName(st.lang, type, nth)
    const id = makeId('s')
    const stroke = '#1b1d22'
    const base = { id, name, stroke, opacity: 1, fillRule: 'nonzero' as const }
    let shape: Shape
    switch (type) {
      case 'rect': {
        const w = clamp(260 * scale, 24, doc.width * 0.6)
        const h = clamp(180 * scale, 24, doc.height * 0.6)
        shape = {
          ...base,
          type: 'rect',
          fill: PALETTE[doc.shapes.length % 6]!,
          strokeWidth: 2,
          x: clamp((doc.width - w) / 2 + cascade, 4, Math.max(4, doc.width - w - 4)),
          y: clamp((doc.height - h) / 2 + cascade, 4, Math.max(4, doc.height - h - 4)),
          w,
          h,
          rx: clamp(18 * scale, 0, Math.min(w, h) / 2)
        }
        break
      }
      case 'ellipse': {
        const rx = clamp(135 * scale, 12, doc.width * 0.29)
        const ry = clamp(105 * scale, 12, doc.height * 0.29)
        shape = {
          ...base,
          type: 'ellipse',
          fill: PALETTE[(doc.shapes.length + 1) % 6]!,
          strokeWidth: 2,
          cx: clamp(doc.width / 2 + cascade, rx + 4, doc.width - rx - 4),
          cy: clamp(doc.height / 2 + cascade, ry + 4, doc.height - ry - 4),
          rx,
          ry
        }
        break
      }
      case 'circle': {
        const r = clamp(112 * scale, 12, Math.min(doc.width, doc.height) * 0.3)
        shape = {
          ...base,
          type: 'circle',
          fill: PALETTE[(doc.shapes.length + 2) % 6]!,
          strokeWidth: 2,
          cx: clamp(doc.width / 2 + cascade, r + 4, doc.width - r - 4),
          cy: clamp(doc.height / 2 + cascade, r + 4, doc.height - r - 4),
          r
        }
        break
      }
      case 'polygon': {
        const radius = clamp(122 * scale, 16, Math.min(doc.width, doc.height) * 0.32)
        const cx = clamp(doc.width / 2 + cascade, radius + 4, doc.width - radius - 4)
        const cy = clamp(doc.height / 2 + cascade, radius + 4, doc.height - radius - 4)
        shape = {
          ...base,
          type: 'polygon',
          fill: PALETTE[(doc.shapes.length + 3) % 6]!,
          strokeWidth: 2,
          points: regularPolygonPoints(cx, cy, radius, 5)
        }
        break
      }
      case 'line': {
        shape = {
          ...base,
          type: 'line',
          fill: 'none',
          strokeWidth: 3,
          x1: clamp(doc.width * 0.28 + cascade, 4, doc.width - 4),
          y1: clamp(doc.height * 0.62 + cascade, 4, doc.height - 4),
          x2: clamp(doc.width * 0.7 + cascade, 4, doc.width - 4),
          y2: clamp(doc.height * 0.37 + cascade, 4, doc.height - 4)
        }
        break
      }
      case 'text': {
        const fontSize = clamp(96 * scale, 12, 400)
        shape = {
          ...base,
          type: 'text',
          fill: PALETTE[(doc.shapes.length + 4) % 6]!,
          stroke: 'none',
          strokeWidth: 0,
          x: clamp(doc.width * 0.25 + cascade, 4, Math.max(4, doc.width * 0.6)),
          y: clamp(doc.height * 0.38 + cascade, 4, Math.max(4, doc.height - fontSize * 1.3)),
          text: this.t('text.sample'),
          fontFamily: '',
          fontDisplay: '',
          fontSize
        }
        break
      }
      case 'path':
      default: {
        const c = cascade
        shape = {
          ...base,
          type: 'path',
          fill: 'none',
          strokeWidth: 5,
          commands: [
            { id: makeId('c'), type: 'M', x: doc.width * 0.28 + c, y: doc.height * 0.625 + c },
            {
              id: makeId('c'),
              type: 'C',
              x1: doc.width * 0.37 + c,
              y1: doc.height * 0.36 + c,
              x2: doc.width * 0.52 + c,
              y2: doc.height * 0.77 + c,
              x: doc.width * 0.67 + c,
              y: doc.height * 0.48 + c
            }
          ]
        }
        break
      }
    }
    doc.shapes.push(shape)
    this.setSelectedIds([id], id)
    if (shape.type === 'path') st.selectedCmdId = this.lastNonZ(shape)?.id ?? null
    st.pathEdit = true
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.added', { label: shape.name }))
  }

  /** 追加一条路径命令：基准点在链尾，方向看哪边空间大；Z 需至少一条线段且只能一次 */
  addPathCommand(letter: unknown): void {
    const st = this.state
    const single = this.singleSelected()
    if (!st.doc || !single || single.type !== 'path') return
    const type = String(letter ?? '') as 'M' | 'L' | 'Q' | 'C' | 'A' | 'Z'
    if (!COMMAND_TYPES.includes(type)) return
    const doc = st.doc
    if (type === 'Z') {
      if (single.commands.some((c) => c.type === 'Z')) {
        this.toast(this.t('toast.pathClosed'))
        return
      }
      if (!single.commands.some((c) => c.type !== 'M' && c.type !== 'Z')) {
        this.toast(this.t('toast.needSegment'))
        return
      }
    }
    this.commitEdit()
    const before = this.snapshot()
    const commands = single.commands.slice()
    const lastIsZ = commands.length > 0 && commands[commands.length - 1]!.type === 'Z'
    const insertIndex = lastIsZ && type !== 'M' ? commands.length - 1 : commands.length
    const base = pointBefore(commands, insertIndex) ?? { x: 300, y: 320 }
    const dirX = doc.width - 34 - base.x < 100 ? -1 : 1
    const dirY = doc.height - 34 - base.y < 100 ? -1 : 1
    const id = makeId('c')
    let cmd: PathCommand
    switch (type) {
      case 'M':
        cmd = { id, type: 'M', x: clamp(base.x + 70 * dirX, 24, doc.width - 24), y: clamp(base.y + 70 * dirY, 24, doc.height - 24) }
        break
      case 'L':
        cmd = { id, type: 'L', x: clamp(base.x + 88 * dirX, 16, doc.width - 16), y: base.y }
        break
      case 'Q':
        cmd = {
          id,
          type: 'Q',
          x1: clamp(base.x + 45 * dirX, 8, doc.width - 8),
          y1: clamp(base.y - 66, 8, doc.height - 8),
          x: clamp(base.x + 108 * dirX, 16, doc.width - 16),
          y: base.y
        }
        break
      case 'C':
        cmd = {
          id,
          type: 'C',
          x1: clamp(base.x + 44 * dirX, 8, doc.width - 8),
          y1: clamp(base.y - 28, 8, doc.height - 8),
          x2: clamp(base.x + 96 * dirX, 8, doc.width - 8),
          y2: clamp(base.y - 72, 8, doc.height - 8),
          x: clamp(base.x + 154 * dirX, 16, doc.width - 16),
          y: base.y
        }
        break
      case 'A': {
        const adx = doc.width - base.x > base.x ? 1 : -1
        const ady = doc.height - base.y > base.y ? 1 : -1
        const spanX = adx > 0 ? doc.width - base.x : base.x
        const spanY = ady > 0 ? doc.height - base.y : base.y
        const longAxis = spanX >= spanY
        const b = clamp(Math.min(doc.width, doc.height) * 0.28, 24, 140)
        const rn = Math.max(10, Math.min(b, (longAxis ? spanX : spanY) * 0.9))
        const rx = Math.max(8, rn * 0.72)
        const ry = Math.max(6, rn * 0.56)
        const ddir = longAxis ? adx : ady
        cmd = {
          id,
          type: 'A',
          rx,
          ry,
          rotation: 0,
          largeArc: 0,
          sweep: ddir > 0 ? 1 : 0,
          x: longAxis ? clamp(base.x + rn * adx, 16, doc.width - 16) : base.x,
          y: longAxis ? base.y : clamp(base.y + rn * ady, 16, doc.height - 16)
        }
        break
      }
      case 'Z':
      default:
        cmd = { id, type: 'Z' }
        break
    }
    commands.splice(insertIndex, 0, cmd)
    single.commands = commands
    st.selectedCmdId = id
    st.pathEdit = true
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    requestAnimationFrame(() => {
      const card = this.el('inspector').querySelector(`[data-cmd-card="${id}"]`)
      if (card && 'scrollIntoView' in card) (card as HTMLElement).scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
    this.toast(this.t('toast.commandAdded', { type: this.t(`cmd.${type}`) }))
  }

  deletePathCommand(cmdId: string): void {
    const st = this.state
    const single = this.singleSelected()
    if (!single || single.type !== 'path') return
    const index = single.commands.findIndex((c) => c.id === cmdId)
    if (index < 0) return
    if (index === 0) {
      this.toast(this.t('toast.startNoDelete'))
      return
    }
    this.commitEdit()
    const before = this.snapshot()
    single.commands.splice(index, 1)
    st.selectedCmdId = single.commands[Math.min(index, single.commands.length - 1)]?.id ?? null
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.commandDeleted'))
  }

  deleteShapeById(id: string): void {
    const st = this.state
    if (!st.doc) return
    const index = st.doc.shapes.findIndex((s) => s.id === id)
    if (index < 0) return
    this.commitEdit()
    const before = this.snapshot()
    const [gone] = st.doc.shapes.splice(index, 1)
    st.selectedIds = st.selectedIds.filter((x) => x !== id)
    if (st.selectedId === id) st.selectedId = st.selectedIds[st.selectedIds.length - 1] ?? null
    if (st.selectedIds.length === 1) {
      const single = this.singleSelected()
      if (single?.type === 'path') st.selectedCmdId = this.preferredCommand(single)?.id ?? null
    } else if (st.selectedIds.length === 0) {
      st.selectedCmdId = null
    }
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.shapeDeleted', { label: gone?.name ?? '' }))
  }

  deleteSelection(): void {
    const st = this.state
    if (!st.doc || st.selectedIds.length === 0) return
    this.commitEdit()
    const before = this.snapshot()
    const wanted = new Set(st.selectedIds)
    const removedLabels = st.doc.shapes.filter((s) => wanted.has(s.id)).map((s) => s.name)
    st.doc.shapes = st.doc.shapes.filter((s) => !wanted.has(s.id))
    this.setSelectedIds([])
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(wanted.size === 1 ? this.t('toast.shapeDeleted', { label: removedLabels[0] ?? '' }) : this.tf('toast.shapesDeleted', wanted.size, {}))
  }

  duplicateSelection(): void {
    const st = this.state
    if (!st.doc || st.selectedIds.length === 0) return
    this.commitEdit()
    const before = this.snapshot()
    const src = this.selectedShapes()
    const copies: Shape[] = []
    for (const shape of src) {
      const copy = this.deepClone(shape) as Shape & { sourceKey?: string }
      copy.id = makeId('s')
      delete copy.sourceKey
      copy.name = copy.name.replace(/\s+\d+$/, '') + this.t('name.copySuffix')
      if (copy.type === 'path') {
        copy.commands = copy.commands.map((c) => ({ ...c, id: makeId('c') }) as PathCommand)
      }
      translateShape(copy, 24, 24)
      copies.push(copy)
    }
    if (src.length === 1) {
      const at = st.doc.shapes.findIndex((s) => s.id === src[0]!.id)
      st.doc.shapes.splice(at + 1, 0, copies[0]!)
    } else {
      st.doc.shapes.push(...copies)
    }
    this.setSelectedIds(copies.map((c) => c.id), copies[copies.length - 1]!.id)
    const single = this.singleSelected()
    if (single && single.type === 'path' && copies.length === 1) st.selectedCmdId = this.lastNonZ(single)?.id ?? null
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(copies.length === 1 ? this.t('toast.shapeDuplicated') : this.tf('toast.shapesDuplicated', copies.length, {}))
  }

  /* ================= 对齐 / 分布 / 布尔 ================= */

  alignSelection(mode: string): void {
    const st = this.state
    if (!st.doc) return
    const list = this.selectedShapes()
    if (list.length === 0) return
    this.commitEdit()
    const before = this.snapshot()
    const ref = list.length === 1 ? { x: 0, y: 0, w: st.doc.width, h: st.doc.height } : (unionBoxes(list.map((s) => this.shapeBox(s))) ?? { x: 0, y: 0, w: 0, h: 0 })
    let changed = false
    for (const shape of list) {
      const d = alignOffset(this.shapeBox(shape), ref, mode as AlignKind)
      if (Math.abs(d.dx) > 1e-6 || Math.abs(d.dy) > 1e-6) {
        translateShape(shape, d.dx, d.dy)
        changed = true
      }
    }
    if (!changed) {
      this.toast(this.t('align.already'))
      return
    }
    this.pushHistory(before)
    this.renderShapeLayer()
    this.renderInspector()
    this.scheduleSave()
    const labelKey = ['left', 'center', 'right', 'top', 'middle', 'bottom'].includes(mode) ? `align.${mode}` : 'align.aligned'
    this.toast(this.t(labelKey))
  }

  distributeSelection(axis: 'x' | 'y'): void {
    const st = this.state
    if (!st.doc) return
    const list = this.selectedShapes()
    if (list.length < 3) {
      this.toast(this.t('align.needThree'))
      return
    }
    this.commitEdit()
    const before = this.snapshot()
    const moves = distributeOffsets(list.map((s) => ({ id: s.id, bounds: this.shapeBox(s) })), axis)
    let changed = false
    for (const move of moves) {
      if (Math.abs(move.dx) > 1e-6 || Math.abs(move.dy) > 1e-6) changed = true
      const shape = this.findShape(move.id)
      if (shape) translateShape(shape, move.dx, move.dy)
    }
    if (!changed) {
      this.toast(this.t('align.alreadyEven'))
      return
    }
    this.pushHistory(before)
    this.renderShapeLayer()
    this.renderInspector()
    this.scheduleSave()
    this.toast(this.t(axis === 'x' ? 'align.distributedX' : 'align.distributedY'))
  }

  /** 布尔：样式按"差集用底层、其余用顶层，顶层没填充就找第一个有填充的"；落回原层位 */
  applyBoolean(kind: string): void {
    const st = this.state
    if (!st.doc) return
    const op = kind as 'unite' | 'subtract' | 'intersect' | 'exclude'
    if (!BOOLEAN_KINDS.includes(op)) return
    const selected = this.selectedShapes()
    if (selected.length < 2) {
      this.toast(this.t('toast.booleanMin'))
      return
    }
    if (selected.some((s) => s.type === 'line')) {
      this.toast(this.t('toast.lineNoArea'))
      return
    }
    const operands: Array<{ d: string; fillRule: string }> = []
    for (const shape of selected) {
      const d = shapeToPathAttr(shape)
      if (!d) {
        this.toast(this.t('toast.cannotRead'))
        return
      }
      operands.push({ d, fillRule: shape.fillRule })
    }
    let outcome: ReturnType<typeof runBoolean> = null
    try {
      outcome = runBoolean(operands, op)
    } catch (err) {
      console.error('[albedo] boolean failed', err)
      const message = err instanceof Error && err.message ? err.message : this.t('toast.maySelfIntersect')
      this.toast(this.t('toast.booleanFailed', { message }))
      return
    }
    if (!outcome) {
      this.toast(this.t('toast.emptyResult'))
      return
    }
    this.commitEdit()
    const before = this.snapshot()
    const bottom = selected[0]!
    const top = selected[selected.length - 1]!
    const styleSource = op === 'subtract' ? bottom : top
    const paintFrom = styleSource.fill !== 'none' ? styleSource : (selected.find((s) => s.fill !== 'none') ?? styleSource)
    const indices = selected.map((s) => st.doc!.shapes.indexOf(s))
    const keepIndex = op === 'subtract' ? Math.min(...indices) : Math.max(...indices)
    const selectedIds = new Set(selected.map((s) => s.id))
    const keepBefore = st.doc.shapes.filter((s, i) => !selectedIds.has(s.id) && i < keepIndex).length
    const removedShapes = st.doc.shapes.filter((s) => selectedIds.has(s.id))
    st.doc.shapes = st.doc.shapes.filter((s) => !selectedIds.has(s.id))
    const shape: Shape = {
      id: makeId('s'),
      type: 'path',
      name: this.t(`boolean.${op}`),
      fill: paintFrom.fill,
      stroke: paintFrom.stroke,
      strokeWidth: paintFrom.strokeWidth,
      opacity: paintFrom.opacity,
      fillRule: outcome.fillRule,
      commands: normalizeCommands(
        outcome.segments.map((seg) => ({ ...seg, id: makeId('c') }))
      )
    }
    st.doc.shapes.splice(keepBefore, 0, shape)
    void removedShapes
    this.setSelectedIds([shape.id], shape.id)
    st.selectedCmdId = null
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.generated', { label: shape.name }))
  }

  /* ================= 数值写入 / 微移 / 新建 ================= */

  nudgeSelection(dx: number, dy: number): void {
    const st = this.state
    if (!st.doc || st.selectedIds.length === 0) return
    this.commitEdit()
    const before = this.snapshot()
    for (const shape of this.selectedShapes()) translateShape(shape, dx, dy)
    this.pushHistory(before)
    this.renderShapeLayer()
    this.renderInspector()
    this.scheduleSave()
  }

  /**
   * 检查器单个字段写入。钳制口径与单文件版一致：rx 下限 0，w/h/ry 下限 0.5，
   * r 下限 1，fontSize 1..5000，opacity 0..1，strokeWidth 0..120。
   * 历史由调用方（input 事件的 beginEdit 合并）负责。
   */
  setShapeProp(target: HTMLElement, prop: string, value: unknown): void {
    const st = this.state
    const numericKeys = ['x', 'y', 'w', 'h', 'rx', 'cx', 'cy', 'x1', 'y1', 'x2', 'y2', 'ry', 'r', 'fontSize', 'strokeWidth', 'opacity']
    const shape = prop === 'background' ? null : this.singleSelected()
    if (prop === 'background') {
      if (typeof value === 'string' && (value === 'none' || this.isHexColor(value))) {
        st.doc!.background = value
        this.el('canvasBg').setAttribute('fill', value === 'none' ? 'transparent' : value)
        this.scheduleSave()
      }
      return
    }
    if (!shape) return
    if (numericKeys.includes(prop)) {
      const n = Number(value)
      if (!Number.isFinite(n)) return
      let v = n
      if (prop === 'w' || prop === 'h' || prop === 'ry') v = Math.max(0.5, v)
      if (prop === 'rx') v = Math.max(0, v)
      if (prop === 'r') v = Math.max(1, v)
      if (prop === 'fontSize') v = clamp(v, 1, 5000)
      if (prop === 'opacity') v = clamp(v, 0, 1)
      if (prop === 'strokeWidth') v = clamp(v, 0, 120)
      const rec = shape as unknown as Record<string, unknown>
      rec[prop] = v
      this.renderShapeLayer()
      if (prop === 'opacity') {
        const pct = this.el('inspector').querySelector('[data-opacity-label]')
        if (pct) pct.textContent = `${Math.round(v * 100)}%`
      }
      this.scheduleSave()
      return
    }
    if (prop === 'fill') {
      if (typeof value === 'string' && (value === 'none' || this.isHexColor(value))) {
        ;(shape as Shape).fill = shape.type === 'line' ? 'none' : value
        this.renderShapeLayer()
        this.scheduleSave()
      }
      return
    }
    if (prop === 'stroke') {
      if (typeof value === 'string' && (value === 'none' || this.isHexColor(value))) {
        shape.stroke = value
        this.renderShapeLayer()
        this.scheduleSave()
      }
      return
    }
    if (prop === 'text' && shape.type === 'text') {
      shape.text = typeof value === 'string' ? value : ''
      this.renderShapeLayer()
      this.scheduleSave()
    }
  }

  commitDocName(): void {
    const st = this.state
    if (!st.doc) return
    const input = this.el('docTitle') as HTMLInputElement
    st.doc.name = input.value.trim() || this.t('doc.untitled')
    void this.api.window.setTitle(st.doc.name).catch(() => undefined)
    this.scheduleSave()
  }

  /** "新建"：清形状、留桌布、留尺寸；可撤销 */
  newBlankDocument(): void {
    const st = this.state
    if (!st.doc) return
    this.commitEdit()
    const prev = this.snapshot()
    const prevSource = st.source
    const width = st.doc.width
    const height = st.doc.height
    st.doc = normalizeDoc({ width, height }, st.lang)
    st.source = null
    st.sourceSerial = 0
    st.sourceByDoc.set(prev, prevSource)
    st.sourceByDoc.set(this.snapshot(), null)
    st.sourcePersisted = false
    this.setSelectedIds([])
    st.pathEdit = true
    st.underlayAdjust = false
    this.syncDocTitleInput()
    this.pushHistory(prev)
    this.fullRefresh()
    void this.saveNow()
    this.toast(this.t(st.underlay ? 'toast.newBlankKeep' : 'toast.newBlank'))
  }
  /* ================= 指针手势 ================= */

  snapOptions(extraPoints: Array<{ x: number; y: number } | null> = []): SnapOptionsFor {
    const st = this.state
    const doc = st.doc!
    const selectedIds = new Set(st.selectedIds)
    return {
      enabled: st.snapEnabled,
      threshold: SNAP_THRESHOLD_PX * this.uiScaleOf(),
      grid: { enabled: st.grid.visible, size: st.grid.size },
      artboard: { w: doc.width, h: doc.height },
      targets: doc.shapes.filter((s) => !selectedIds.has(s.id)).map((s) => this.shapeBox(s)),
      points: extraPoints
    }
  }

  /** 节点拖动的吸附上下文：其它路径命令的端点（不含正在拖的这一点） */
  nodeSnapContext(cmdId: string): SnapOptionsFor {
    const st = this.state
    const opts = this.snapOptions([])
    const pts: Array<{ x: number; y: number }> = []
    for (const shape of st.doc?.shapes ?? []) {
      if (shape.type !== 'path') continue
      for (const c of shape.commands) {
        if (c.id === cmdId) continue
        if ('x' in c && 'y' in c && typeof c.x === 'number' && typeof c.y === 'number') pts.push({ x: c.x, y: c.y })
      }
    }
    opts.points = pts
    return opts
  }

  private startGestureCommon(e: { clientX: number; clientY: number; preventDefault(): void }): void {
    this.commitEdit()
    document.body.classList.add('is-dragging')
    const move = (ev: PointerEvent): void => this.onPointerMove(ev)
    const end = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      this.onPointerEnd(ev)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    e.preventDefault()
  }

  startMove(e: { clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void }): void {
    const st = this.state
    const list = this.selectedShapes()
    if (!st.doc || list.length === 0) return
    const originals = list.map((s) => this.deepClone(s))
    this.startGestureCommon(e)
    st.gesture = {
      kind: 'move',
      start: this.eventToDoc(e),
      ids: list.map((s) => s.id),
      originals,
      bounds: unionBoxes(list.map((s) => this.shapeBox(s))) ?? { x: 0, y: 0, w: 0, h: 0 },
      before: this.snapshot(),
      moved: false
    } as MoveGesture
  }

  startResize(e: { clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void }, handle: string): void {
    const st = this.state
    const single = this.singleSelected()
    if (!st.doc || !single || !handle) return
    this.startGestureCommon(e)
    st.gesture = {
      kind: 'resize',
      start: this.eventToDoc(e),
      ids: [single.id],
      originals: [this.deepClone(single)],
      bounds: this.shapeBox(single),
      originalBounds: this.shapeBox(single),
      handle,
      keepAspect: single.type === 'circle',
      before: this.snapshot(),
      moved: false
    } as ResizeGesture
  }

  startNodeDrag(e: { clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void }, cmdId: string | undefined, part: string): void {
    const st = this.state
    const single = this.singleSelected()
    if (!st.doc || !single || single.type !== 'path' || !cmdId) return
    if (!single.commands.some((c) => c.id === cmdId)) return
    this.selectCommand(cmdId, false)
    this.startGestureCommon(e)
    st.gesture = {
      kind: 'node',
      start: this.eventToDoc(e),
      shapeId: single.id,
      cmdId,
      part,
      original: this.deepClone(single),
      before: this.snapshot(),
      moved: false
    } as NodeGesture
  }

  startUnderlayDrag(e: { clientX: number; clientY: number; shiftKey: boolean; preventDefault(): void }, part: string | undefined): void {
    const st = this.state
    if (!st.underlay || !st.underlay.visible || !st.underlayAdjust || !part) return
    this.startGestureCommon(e)
    const start = this.eventToDoc(e)
    st.gesture = {
      kind: part === 'move' ? 'underlay-move' : 'underlay-resize',
      start,
      part,
      pointerOffset: part === 'move' ? { x: 0, y: 0 } : { x: start.x - this.underlayCorner(part).x, y: start.y - this.underlayCorner(part).y },
      original: { x: st.underlay.x, y: st.underlay.y, w: st.underlay.w, h: st.underlay.h },
      moved: false
    } as UnderlayGesture
  }

  private underlayCorner(part: string): { x: number; y: number } {
    const u = this.state.underlay!
    const x = part.includes('w') ? u.x : u.x + u.w
    const y = part.includes('n') ? u.y : u.y + u.h
    return { x, y }
  }

  startMarquee(e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault(): void }): void {
    const st = this.state
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    st.marquee = { x: 0, y: 0, w: 0, h: 0 }
    this.startGestureCommon(e)
    document.body.classList.remove('is-dragging')
    document.body.classList.add('is-selecting')
    st.gesture = {
      kind: 'marquee',
      start: this.eventToDoc(e),
      additive,
      beforeSelection: [...st.selectedIds],
      moved: false
    } as MarqueeGesture
  }

  onPointerMove(e: PointerEvent): void {
    const st = this.state
    const gesture = st.gesture
    if (!gesture) return
    const p = this.eventToDoc(e)
    let dx = p.x - gesture.start.x
    let dy = p.y - gesture.start.y
    if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) gesture.moved = true

    if (gesture.kind === 'underlay-move' || gesture.kind === 'underlay-resize') {
      st.snapGuides = []
      this.applyUnderlayGesture(gesture as UnderlayGesture, p, e)
      this.renderPointerCoord(p)
      return
    }
    if (gesture.kind === 'marquee') {
      const m = gesture as MarqueeGesture
      st.marquee = {
        x: Math.min(m.start.x, p.x),
        y: Math.min(m.start.y, p.y),
        w: Math.abs(p.x - m.start.x),
        h: Math.abs(p.y - m.start.y)
      }
      if (st.marquee.w > 1 || st.marquee.h > 1) m.moved = true
      this.renderPointerCoord(p)
      this.renderOverlay()
      return
    }
    if (gesture.kind === 'move') {
      const g = gesture as MoveGesture
      let lockX = false
      let lockY = false
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) {
          dy = 0
          lockY = true
        } else {
          dx = 0
          lockX = true
        }
      }
      const snap = st.snapEnabled && !e.altKey ? snapMove(g.bounds, dx, dy, this.snapOptions()) : { dx, dy, guides: [] as SnapGuide[] }
      let finalDx = snap.dx
      let finalDy = snap.dy
      let guides = snap.guides
      if (lockY) finalDy = 0
      if (lockX) finalDx = 0
      if (lockY) guides = guides.filter((gu) => gu.axis !== 'y')
      if (lockX) guides = guides.filter((gu) => gu.axis !== 'x')
      for (let i = 0; i < g.ids.length; i += 1) {
        const live = this.findShape(g.ids[i]!)
        const original = g.originals[i]
        if (!live || !original) continue
        Object.assign(live, this.deepClone(original))
        translateShape(live, finalDx, finalDy)
      }
      st.snapGuides = guides
    } else if (gesture.kind === 'resize') {
      const g = gesture as ResizeGesture
      let box = resizeBounds(g.originalBounds, [String(g.handle)], dx, dy, e.shiftKey || g.keepAspect)
      if (st.snapEnabled && !e.altKey) {
        const snapped = snapResize(box, [String(g.handle)], this.snapOptions())
        box = snapped.bounds
        st.snapGuides = snapped.guides
      } else {
        st.snapGuides = []
      }
      for (let i = 0; i < g.ids.length; i += 1) {
        const live = this.findShape(g.ids[i]!)
        const original = g.originals[i]
        if (!live || !original) continue
        if (g.ids.length === 1) reshapeToBounds(live, original, g.originalBounds, box)
        else this.scaleShapeIntoBox(live, original, g.originalBounds, box)
      }
    } else if (gesture.kind === 'node') {
      const g = gesture as NodeGesture
      const original = g.original
      if (original.type !== 'path') return
      const commands = this.deepClone(original.commands)
      const index = commands.findIndex((c) => c.id === g.cmdId)
      if (index < 0) return
      const cmd = commands[index]!
      const guides: SnapGuide[] = []
      if (g.part === 'anchor') {
        const target = { x: cmd.type === 'Z' ? 0 : (cmd as { x: number }).x + dx, y: cmd.type === 'Z' ? 0 : (cmd as { y: number }).y + dy }
        const snapped = snapPoint(target, this.nodeSnapContext(g.cmdId))
        if (snapped.point) {
          if ('x' in cmd) (cmd as { x: number }).x = snapped.point.x
          if ('y' in cmd) (cmd as { y: number }).y = snapped.point.y
        }
        guides.push(...snapped.guides)
      } else {
        const rec = cmd as unknown as Record<string, number>
        const key = g.part === 'c' || g.part === 'c1' ? 'x1' : 'x2'
        const keyY = g.part === 'c' || g.part === 'c1' ? 'y1' : 'y2'
        const src = original.commands[index] as unknown as Record<string, number>
        rec[key] = Number(src[key]) + dx
        rec[keyY] = Number(src[keyY]) + dy
        st.snapGuides = []
      }
      const live = this.findShape(g.shapeId)
      if (live && live.type === 'path') {
        live.commands = commands as PathCommand[]
      }
      st.snapGuides = st.snapGuides.length && g.part !== 'anchor' ? st.snapGuides : guides
    }
    this.renderPointerCoord(p)
    this.renderShapeLayer()
    this.syncInspectorValues()
  }

  onPointerEnd(_e: PointerEvent): void {
    const st = this.state
    const gesture = st.gesture
    document.body.classList.remove('is-dragging', 'is-selecting')
    if (!gesture) return
    st.gesture = null
    if (gesture.kind === 'underlay-move' || gesture.kind === 'underlay-resize') {
      if (gesture.moved) {
        this.renderInspector()
        this.renderInspectorRail()
        this.renderUnderlayPanel()
        void this.persistUnderlayNow()
      } else {
        this.renderOverlay()
      }
      this.renderStatus()
      return
    }
    if (gesture.kind === 'marquee') {
      const m = gesture as MarqueeGesture
      const box = st.marquee
      st.marquee = null
      st.snapGuides = []
      if (box && (box.w > 1 || box.h > 1) && st.doc) {
        const hits = st.doc.shapes.filter((s) => rectsIntersect(this.shapeBox(s), box)).map((s) => s.id)
        const ids = m.additive ? [...new Set([...m.beforeSelection, ...hits])] : hits
        this.setSelection(ids)
      } else {
        this.renderOverlay()
      }
      return
    }
    st.snapGuides = []
    if (gesture.moved && gesture.before) {
      this.pushHistory(gesture.before)
      this.scheduleSave()
      this.renderInspector()
      this.renderInspectorRail()
      this.renderLayerList()
      this.renderOverlay()
      this.renderStatus()
    } else {
      this.renderOverlay()
    }
  }

  /** 多选拉手缩放：circle 在多选里会被拉成椭圆（原行为）；单选走 reshapeToBounds 保圆 */
  private scaleShapeIntoBox(live: Shape, original: Shape, src: Box, dst: Box): void {
    if (original.type === 'circle' && (dst.w - dst.h) * (dst.w - dst.h) > 1e-6) {
      const ellipse: Shape = {
        ...(live as Shape),
        type: 'ellipse',
        cx: dst.x + dst.w / 2,
        cy: dst.y + dst.h / 2,
        rx: Math.max(1, dst.w / 2),
        ry: Math.max(1, dst.h / 2)
      } as Shape
      Object.assign(live, ellipse)
      return
    }
    reshapeToBounds(live, original, src, dst)
  }

  private applyUnderlayGesture(g: UnderlayGesture, p: { x: number; y: number }, e: { shiftKey: boolean }): void {
    const st = this.state
    const u = st.underlay
    if (!u) return
    const o = g.original
    if (g.part === 'move') {
      let dx = p.x - g.start.x
      let dy = p.y - g.start.y
      if (e.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0
        else dx = 0
      }
      u.x = o.x + dx
      u.y = o.y + dy
    } else {
      const anchor = {
        x: o.x + (g.part.includes('w') ? o.w : 0),
        y: o.y + (g.part.includes('n') ? o.h : 0)
      }
      const vx = g.part.includes('w') ? -1 : 1
      const vy = g.part.includes('n') ? -1 : 1
      const at = vx * o.w
      const up = vy * o.h
      const px = p.x - anchor.x
      const py = p.y - anchor.y
      const denom = at * at + up * up
      if (denom <= 0) return
      let t = (px * at + py * up) / denom
      const minT = Math.max(8 / Math.max(1, o.w), 8 / Math.max(1, o.h))
      if (t < minT) t = minT
      const w = Math.max(8, o.w * t)
      const h = Math.max(8, o.h * t)
      u.w = w
      u.h = h
      u.x = g.part.includes('w') ? anchor.x - w : anchor.x
      u.y = g.part.includes('n') ? anchor.y - h : anchor.y
    }
    this.updateUnderlayImage()
    this.renderOverlay()
    this.syncUnderlayInputs()
    this.renderPointerCoord(p)
  }

  static rectsIntersectOverlap(a: Box, b: Box): boolean {
    return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
  }
  /* ================= 检查器（innerHTML 全量重建，保留滚动位） ================= */

  private shapeTitle(type: ShapeType): string {
    return this.t(type === 'path' ? 'shape.pathTitle' : `shape.${type}`)
  }

  private cmdTitle(type: string): string {
    return this.t(`cmd.${type}`)
  }

  private cmdShort(type: string): string {
    return this.t(`cmd.short.${type}`)
  }

  private numberField(label: string, prop: string, value: number, step = 1, suffix = ''): string {
    return (
      `<div class="field"><label>${this.escapeHtml(label)}${suffix ? ` · ${this.escapeHtml(suffix)}` : ''}</label>` +
      `<div class="input-shell"><input type="number" data-prop="${prop}" data-cast="number" step="${step}" value="${this.escapeHtml(fmt2(value))}"></div></div>`
    )
  }

  private colorField(label: string, prop: string, value: string, allowNone = true): string {
    const none = value === 'none'
    return (
      `<div class="color-field field full"><div class="field-label">${this.escapeHtml(label)}</div><div class="color-control">` +
      `<label class="swatch${none ? ' is-none' : ''}" style="--swatch:${none ? 'transparent' : this.escapeHtml(value)}" title="${this.escapeHtml(this.t('inspector.swatchTitle'))}">` +
      `<input type="color" data-prop="${prop}" value="${none ? '#000000' : this.escapeHtml(value)}" aria-label="${this.escapeHtml(label)}"></label>` +
      `<div class="hex-box"><input type="text" data-prop="${prop}" data-color-text="true" maxlength="7" placeholder="${this.escapeHtml(this.t('inspector.none'))}" value="${this.escapeHtml(none ? '' : value)}" aria-label="${this.escapeHtml(this.t('inspector.hexAria', { label }))}"></div>` +
      (allowNone ? `<button type="button" class="none-chip${none ? ' active' : ''}" data-set-none="${prop}">${this.escapeHtml(this.t('inspector.none'))}</button>` : '') +
      '</div></div>'
    )
  }

  private alignGrid(scopeKey: string): string {
    const buttons: Array<[string, string, string]> = [
      ['left', '\u21E4', 'align.left'],
      ['center', '\u2194', 'align.center'],
      ['right', '\u21E5', 'align.right'],
      ['top', '\u21E1', 'align.top'],
      ['middle', '\u2195', 'align.middle'],
      ['bottom', '\u21E3', 'align.bottom']
    ]
    const scope = this.t(scopeKey)
    return (
      '<div class="align-grid">' +
      buttons
        .map(([key, glyph, labelKey]) => {
          const label = this.t(labelKey)
          return `<button type="button" class="tool-btn" data-align="${key}" title="${this.escapeHtml(`${label} · ${scope}`)}"><span class="tool-glyph">${glyph}</span><span>${this.escapeHtml(label)}</span></button>`
        })
        .join('') +
      '</div>'
    )
  }

  private miniIcon(type: ShapeType): string {
    switch (type) {
      case 'rect':
        return '<span class="mini-rect"></span>'
      case 'ellipse':
        return '<span class="mini-ellipse"></span>'
      case 'circle':
        return '<span class="mini-circle"></span>'
      case 'polygon':
        return '<svg class="mini-polygon" viewBox="0 0 20 20" aria-hidden="true"><polygon points="10,2 18,8 15,18 5,18 2,8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></polygon></svg>'
      case 'line':
        return '<span class="mini-line"></span>'
      case 'text':
        return '<span class="mini-text">A</span>'
      default:
        return '<span class="mini-path">\u223F</span>'
    }
  }

  private sectionHead(section: string, title: string, tiny: string, extraAttrs = ''): string {
    return `<section class="ins-section"${extraAttrs ? ` ${extraAttrs}` : ''} data-rail-section="${section}"><div class="ins-section-head"><h2>${this.escapeHtml(title)}</h2><span class="rule"></span><span class="tiny">${this.escapeHtml(tiny)}</span></div>`
  }

  private headActions(): string {
    return (
      `<div class="inspector-actions"><button class="mini-btn" data-action="duplicate" title="${this.escapeHtml(this.t('inspector.duplicate'))}" aria-label="${this.escapeHtml(this.t('inspector.duplicateAria'))}">\u29C9</button>` +
      `<button class="mini-btn danger" data-action="delete" title="${this.escapeHtml(this.t('inspector.delete'))}" aria-label="${this.escapeHtml(this.t('inspector.deleteAria'))}">\u2715</button></div>`
    )
  }

  renderInspector(): void {
    const st = this.state
    if (!st.doc) return
    const selected = this.selectedShapes()
    if (selected.length > 1) {
      this.renderMultiInspector(selected)
      return
    }
    const shape = selected[0] ?? null
    if (!shape) {
      if (st.underlayAdjust && st.underlay?.visible) this.renderUnderlayInspector()
      else this.renderEmptyInspector()
      return
    }
    const scrollTop = this.el('inspector').scrollTop
    const subtitle =
      shape.type === 'path'
        ? this.tf('inspector.commandsCount', shape.commands.length, {})
        : shape.type === 'polygon'
          ? this.tf('inspector.verticesCount', shape.points.length, {})
          : shape.type.toUpperCase()
    let html =
      `<div class="inspector-head"><div class="inspector-icon">${this.miniIcon(shape.type)}</div>` +
      `<div class="inspector-title-block"><h1>${this.escapeHtml(this.shapeTitle(shape.type))}</h1>` +
      `<p>${this.escapeHtml(shape.name)} · ${this.escapeHtml(subtitle)}</p></div>${this.headActions()}</div>`
    html += this.geometrySection(shape)
    if (shape.type === 'path') html += this.pathSection(shape)
    html +=
      this.sectionHead('align', this.t('inspector.alignCanvas'), 'ARTBOARD') + this.alignGrid('align.scopeCanvas') + '</section>'
    html += this.sectionHead('style', this.t('inspector.style'), 'STYLE')
    if (shape.type !== 'line') html += this.colorField(this.t('inspector.fill'), 'fill', shape.fill, true)
    html += this.colorField(this.t('inspector.stroke'), 'stroke', shape.stroke, true)
    html +=
      `<div class="field-grid">${this.numberField(this.t('inspector.strokeWidth'), 'strokeWidth', shape.strokeWidth, 0.5)}` +
      `<div class="field"><span class="field-label">${this.escapeHtml(this.t('inspector.opacity'))}</span>` +
      `<div class="opacity-row"><input type="range" min="0" max="1" step="0.01" data-prop="opacity" value="${fmt2(shape.opacity)}">` +
      `<span class="pct" data-opacity-label>${Math.round(shape.opacity * 100)}%</span></div></div></div></section>`
    this.el('inspector').innerHTML = html
    this.el('inspector').scrollTop = scrollTop
  }

  private geometrySection(shape: Shape): string {
    if (shape.type === 'polygon') {
      const rows = shape.points
        .map((p, i) => {
          const n = i + 1
          return (
            `<div class="poly-vertex-row"><span class="poly-vertex-index">P${n}</span>` +
            `<div class="input-shell"><span class="prefix">X</span><input type="number" data-poly-point="${i}" data-poly-axis="x" step="1" value="${this.escapeHtml(fmt2(p.x))}" aria-label="${this.escapeHtml(this.t('inspector.vertexAria', { n, axis: 'X' }))}"></div>` +
            `<div class="input-shell"><span class="prefix">Y</span><input type="number" data-poly-point="${i}" data-poly-axis="y" step="1" value="${this.escapeHtml(fmt2(p.y))}" aria-label="${this.escapeHtml(this.t('inspector.vertexAria', { n, axis: 'Y' }))}"></div></div>`
          )
        })
        .join('')
      return (
        this.sectionHead('geometry', this.t('inspector.geometry'), 'GEOMETRY') +
        `<div class="field-grid"><div class="field full"><label>${this.escapeHtml(this.t('inspector.sides'))}</label>` +
        `<div class="input-shell"><input type="number" data-poly-sides min="3" max="24" step="1" value="${shape.points.length}" aria-label="${this.escapeHtml(this.t('inspector.sidesAria'))}"></div></div></div>` +
        `<p class="field-hint">${this.escapeHtml(this.t('inspector.polygonHint'))}</p></section>` +
        this.sectionHead('vertices', this.t('inspector.vertices'), 'VERTICES') +
        `<div class="poly-vertex-list">${rows}</div></section>`
      )
    }
    if (shape.type === 'text') {
      return (
        this.sectionHead('geometry', this.t('inspector.geometry'), 'TEXT') +
        `<div class="field-grid"><div class="field full"><label>${this.escapeHtml(this.t('inspector.textContent'))}</label>` +
        `<div class="input-shell"><input type="text" data-prop="text" value="${this.escapeHtml(shape.text)}" aria-label="${this.escapeHtml(this.t('inspector.textContent'))}"></div></div>` +
        this.numberField('X', 'x', shape.x) +
        this.numberField('Y', 'y', shape.y) +
        this.numberField(this.t('inspector.fontSize'), 'fontSize', shape.fontSize, 0.5) +
        `<div class="field full font-field"><span class="field-label">${this.escapeHtml(this.t('inspector.font'))}</span>` +
        `<div class="font-control"><button type="button" class="font-btn" data-action="choose-font" title="${this.escapeHtml(this.t('font.pickTitle'))}">${this.escapeHtml(this.t('inspector.chooseFont'))}</button>` +
        `<span class="font-name" title="${this.escapeHtml(shape.fontDisplay || '')}">${this.escapeHtml(shape.fontDisplay || this.t('inspector.noFont'))}</span></div>` +
        `<p class="field-hint">${this.escapeHtml(this.t('inspector.textHint'))}</p></div></div></section>`
      )
    }
    if (shape.type === 'path') return ''
    let fields = ''
    let gridClass = 'field-grid'
    if (shape.type === 'rect') {
      fields =
        this.numberField('X', 'x', shape.x) + this.numberField('Y', 'y', shape.y) +
        this.numberField('W', 'w', shape.w) + this.numberField('H', 'h', shape.h) +
        this.numberField(this.t('inspector.radius'), 'rx', shape.rx)
    } else if (shape.type === 'ellipse') {
      fields =
        this.numberField('CX', 'cx', shape.cx) + this.numberField('CY', 'cy', shape.cy) +
        this.numberField('RX', 'rx', shape.rx) + this.numberField('RY', 'ry', shape.ry)
    } else if (shape.type === 'circle') {
      fields =
        this.numberField('CX', 'cx', shape.cx) + this.numberField('CY', 'cy', shape.cy) + this.numberField('R', 'r', shape.r)
      gridClass = 'field-grid three'
    } else if (shape.type === 'line') {
      fields =
        this.numberField('X1', 'x1', shape.x1) + this.numberField('Y1', 'y1', shape.y1) +
        this.numberField('X2', 'x2', shape.x2) + this.numberField('Y2', 'y2', shape.y2)
    }
    return this.sectionHead('geometry', this.t('inspector.geometry'), 'GEOMETRY') + `<div class="${gridClass}">${fields}</div></section>`
  }

  private cmdNumberInput(cmdId: string, label: string, key: string, value: number, cls = ''): string {
    return (
      `<div class="field${cls ? ` ${cls}` : ''}"><label>${this.escapeHtml(label)}</label>` +
      `<div class="input-shell"><input type="number" step="1" data-cmd-id="${cmdId}" data-cmd-key="${key}" value="${this.escapeHtml(fmt2(value))}"></div></div>`
    )
  }

  private cmdFlagInput(cmdId: string, flag: 'largeArc' | 'sweep', label: string, checked: boolean): string {
    return `<label class="cmd-flag"><input type="checkbox" data-cmd-flag="${flag}" data-cmd-id="${cmdId}"${checked ? ' checked' : ''}><span>${this.escapeHtml(label)}</span></label>`
  }

  private commandFields(cmd: PathCommand): string {
    switch (cmd.type) {
      case 'Z':
        return `<div class="group-label">${this.escapeHtml(this.t('inspector.endAtStart'))}</div>`
      case 'M':
      case 'L':
        return this.cmdNumberInput(cmd.id, 'X', 'x', cmd.x) + this.cmdNumberInput(cmd.id, 'Y', 'y', cmd.y)
      case 'Q':
        return (
          `<div class="group-label">${this.escapeHtml(this.t('inspector.controlPoint'))}</div>` +
          this.cmdNumberInput(cmd.id, 'CX', 'x1', cmd.x1) +
          this.cmdNumberInput(cmd.id, 'CY', 'y1', cmd.y1) +
          `<div class="group-label">${this.escapeHtml(this.t('inspector.anchor'))}</div>` +
          this.cmdNumberInput(cmd.id, 'X', 'x', cmd.x) +
          this.cmdNumberInput(cmd.id, 'Y', 'y', cmd.y)
        )
      case 'C':
        return (
          `<div class="group-label">${this.escapeHtml(this.t('inspector.control1'))}</div>` +
          this.cmdNumberInput(cmd.id, 'C1X', 'x1', cmd.x1) +
          this.cmdNumberInput(cmd.id, 'C1Y', 'y1', cmd.y1) +
          `<div class="group-label">${this.escapeHtml(this.t('inspector.control2'))}</div>` +
          this.cmdNumberInput(cmd.id, 'C2X', 'x2', cmd.x2) +
          this.cmdNumberInput(cmd.id, 'C2Y', 'y2', cmd.y2) +
          `<div class="group-label">${this.escapeHtml(this.t('inspector.end'))}</div>` +
          this.cmdNumberInput(cmd.id, 'X', 'x', cmd.x) +
          this.cmdNumberInput(cmd.id, 'Y', 'y', cmd.y)
        )
      case 'A':
        return (
          `<div class="group-label">${this.escapeHtml(this.t('inspector.ellipseRadii'))}</div>` +
          this.cmdNumberInput(cmd.id, 'RX', 'rx', cmd.rx) +
          this.cmdNumberInput(cmd.id, 'RY', 'ry', cmd.ry) +
          this.cmdNumberInput(cmd.id, this.t('inspector.rotation'), 'rotation', cmd.rotation, 'wide') +
          `<div class="group-label">${this.escapeHtml(this.t('inspector.arcDirection'))}</div>` +
          `<div class="cmd-arc-flags">${this.cmdFlagInput(cmd.id, 'largeArc', this.t('inspector.largeArc'), Boolean(cmd.largeArc))}` +
          `${this.cmdFlagInput(cmd.id, 'sweep', this.t('inspector.sweep'), Boolean(cmd.sweep))}</div>` +
          `<div class="group-label">${this.escapeHtml(this.t('inspector.end'))}</div>` +
          this.cmdNumberInput(cmd.id, 'X', 'x', cmd.x) +
          this.cmdNumberInput(cmd.id, 'Y', 'y', cmd.y)
        )
      default:
        return ''
    }
  }

  private pathSection(shape: Shape & { type: 'path' }): string {
    const st = this.state
    let html =
      this.sectionHead('path', this.t('inspector.pathStack'), 'PATH', 'class="ins-section path-section"') +
      `<label class="switch" title="${this.escapeHtml(this.t('inspector.nodeToggleTitle'))}"><input type="checkbox" data-action="toggle-path-edit"${st.pathEdit ? ' checked' : ''}><span>${this.escapeHtml(this.t('inspector.nodeEditing'))}</span></label></div>` +
      `<p class="panel-hint">${this.t('inspector.pathHint')}</p><div class="cmd-add-bar">` +
      COMMAND_TYPES.map(
        (c) =>
          `<button class="cmd-add" data-add-cmd="${c}" title="${this.escapeHtml(this.t('inspector.addCommand', { name: this.cmdTitle(c) }))}"><span class="code">${c}</span><span class="label">${this.escapeHtml(this.cmdShort(c))}</span></button>`
      ).join('') +
      '</div><div class="cmd-list">'
    shape.commands.forEach((cmd, index) => {
      const selectedCmd = cmd.id === st.selectedCmdId
      const coords = cmd.type === 'Z' ? 'CLOSE' : `${Math.round((cmd as { x?: number }).x ?? 0)}, ${Math.round((cmd as { y?: number }).y ?? 0)}`
      const delTitle = index === 0 ? this.t('inspector.startNoDelete') : this.t('inspector.deleteCommand')
      html +=
        `<article class="cmd-card${selectedCmd ? ' selected' : ''}" data-cmd-card="${cmd.id}">` +
        `<div class="cmd-head" data-select-cmd="${cmd.id}"><span class="cmd-code ${cmd.type}">${cmd.type}</span>` +
        `<span class="cmd-title">${this.escapeHtml(this.cmdTitle(cmd.type))}</span><span class="cmd-coords">${this.escapeHtml(coords)}</span>` +
        `<span class="cmd-index">${String(index + 1).padStart(2, '0')}</span>` +
        `<button class="cmd-del" data-del-cmd="${cmd.id}" title="${this.escapeHtml(delTitle)}"${index === 0 ? ' disabled' : ''}>\u2715</button></div>` +
        `<div class="cmd-body">${this.commandFields(cmd)}</div></article>`
    })
    html +=
      `</div><div class="path-code"><code id="pathCode">${this.escapeHtml(commandsToPath(shape.commands))}</code>` +
      `<button data-copy-path title="${this.escapeHtml(this.t('inspector.copyPath'))}" aria-label="${this.escapeHtml(this.t('inspector.copyPath'))}">\u29C9</button></div>` +
      `<div class="node-legend"><span><i class="legend-anchor"></i>${this.escapeHtml(this.t('inspector.legendAnchor'))}</span>` +
      `<span><i class="legend-control"></i>${this.escapeHtml(this.t('inspector.legendControl'))}</span>` +
      `<span><i class="legend-guide"></i>${this.escapeHtml(this.t('inspector.legendGuide'))}</span></div></section>`
    return html
  }

  private renderMultiInspector(selected: Shape[]): void {
    const st = this.state
    const box = unionBoxes(selected.map((s) => this.shapeBox(s))) ?? { x: 0, y: 0, w: 0, h: 0 }
    const noLine = selected.every((s) => s.type !== 'line')
    const enough = selected.length >= 3
    const ops = (['unite', 'subtract', 'intersect', 'exclude'] as const)
      .map(
        (op) =>
          `<button type="button" class="op-btn" data-boolean="${op}" title="${this.escapeHtml(this.t(`boolean.${op}Title`))}"${noLine ? '' : ' disabled'}><b>${this.escapeHtml(this.t(`boolean.${op}`))}</b><span>${op}</span></button>`
      )
      .join('')
    this.el('inspector').innerHTML =
      `<div class="inspector-head multi-head"><div class="inspector-icon"><span class="multi-count">${selected.length}</span></div>` +
      `<div class="inspector-title-block"><h1>${this.escapeHtml(this.tf('selection.title', selected.length, {}))}</h1>` +
      `<p>${this.escapeHtml(this.t('selection.subtitle', { w: Math.round(box.w), h: Math.round(box.h) }))}</p></div>` +
      `<div class="inspector-actions"><button class="mini-btn" data-action="duplicate" title="${this.escapeHtml(this.t('selection.duplicate'))}" aria-label="${this.escapeHtml(this.t('selection.duplicateAria'))}">\u29C9</button>` +
      `<button class="mini-btn danger" data-action="delete" title="${this.escapeHtml(this.t('selection.delete'))}" aria-label="${this.escapeHtml(this.t('selection.deleteAria'))}">\u2715</button></div></div>` +
      this.sectionHead('operations', this.t('boolean.pathOperations'), 'PAPER.JS') +
      `<div class="op-grid">${ops}</div><p class="panel-hint">${this.escapeHtml(this.t('boolean.hint'))}</p></section>` +
      this.sectionHead('align', this.t('align.title'), enough ? 'SELECTION' : 'NEED 3+') +
      this.alignGrid('align.scopeSelection') +
      `<div class="distribute-row">` +
      `<button type="button" class="tool-btn wide" data-distribute="x"${enough ? '' : ' disabled'} title="${this.escapeHtml(this.t('align.distributeXTitle'))}"><span class="tool-glyph">\u21F9</span><span>${this.escapeHtml(this.t('align.distributeX'))}</span></button>` +
      `<button type="button" class="tool-btn wide" data-distribute="y"${enough ? '' : ' disabled'} title="${this.escapeHtml(this.t('align.distributeYTitle'))}"><span class="tool-glyph">\u21F3</span><span>${this.escapeHtml(this.t('align.distributeY'))}</span></button>` +
      '</div></section>' +
      this.sectionHead('tips', this.t('align.tipsTitle'), 'TIPS', 'class="ins-section compact"') +
      `<p class="panel-hint">${this.escapeHtml(this.t('align.tips'))}</p></section>`
  }

  private renderUnderlayInspector(): void {
    const u = this.state.underlay
    if (!u) {
      this.renderEmptyInspector()
      return
    }
    this.el('inspector').innerHTML =
      `<div class="inspector-head underlay-inspector"><div class="inspector-icon"><span class="mini-underlay">\u25A7</span></div>` +
      `<div class="inspector-title-block"><h1>${this.escapeHtml(this.t('underlay.title'))}</h1><p>${this.escapeHtml(u.name)} · REFERENCE</p></div>` +
      `<div class="inspector-actions"><button class="mini-btn danger" data-underlay-action="remove" title="${this.escapeHtml(this.t('underlay.remove'))}" aria-label="${this.escapeHtml(this.t('underlay.remove'))}">\u2715</button></div></div>` +
      this.sectionHead('position', this.t('underlay.position'), 'TRANSFORM') +
      '<div class="field-grid">' +
      this.underlayField('X', 'x', u.x) +
      this.underlayField('Y', 'y', u.y) +
      this.underlayField(this.t('underlay.width'), 'w', u.w) +
      this.underlayField(this.t('underlay.height'), 'h', u.h) +
      `</div><p class="field-hint">${this.escapeHtml(this.t('underlay.naturalSize', { w: Math.round(u.naturalW), h: Math.round(u.naturalH) }))}</p></section>` +
      this.sectionHead('display', this.t('underlay.display'), 'DISPLAY') +
      `<div class="field"><span class="field-label">${this.escapeHtml(this.t('inspector.opacity'))}</span>` +
      `<div class="opacity-row"><input type="range" min="0.05" max="1" step="0.01" data-underlay-opacity value="${fmt2(u.opacity)}">` +
      `<span class="pct" id="underlayOpacityLabel">${Math.round(u.opacity * 100)}%</span></div></div>` +
      `<div class="underlay-action-grid" style="margin-top:12px">` +
      `<button type="button" class="underlay-action" data-underlay-action="fit">${this.escapeHtml(this.t('underlay.fit'))}</button>` +
      `<button type="button" class="underlay-action" data-underlay-action="fill">${this.escapeHtml(this.t('underlay.fill'))}</button>` +
      `<button type="button" class="underlay-action" data-underlay-action="center">${this.escapeHtml(this.t('underlay.center'))}</button>` +
      '</div></section>' +
      '<section class="ins-section">' +
      `<button type="button" class="underlay-done" data-underlay-action="done">${this.escapeHtml(this.t('underlay.done'))}</button>` +
      `<p class="underlay-export-note">${this.escapeHtml(this.t('underlay.exportNote'))}</p></section>`
  }

  private underlayField(label: string, prop: string, value: number): string {
    return (
      `<div class="field"><label>${this.escapeHtml(label)}</label>` +
      `<div class="input-shell"><input type="number" data-underlay-prop="${prop}" step="1" value="${this.escapeHtml(fmt2(value))}"></div></div>`
    )
  }

  private renderEmptyInspector(): void {
    const st = this.state
    if (!st.doc) return
    this.el('inspector').innerHTML =
      `<div class="empty-inspector"><div class="empty-graphic"><span></span></div>` +
      `<h2>${this.escapeHtml(this.t('inspector.emptyTitle'))}</h2><p>${this.escapeHtml(this.t('inspector.emptyHint'))}</p>` +
      `<div class="doc-settings" data-rail-section="document"><div class="ins-section-head"><h2>${this.escapeHtml(this.t('inspector.document'))}</h2><span class="rule"></span><span class="tiny">DOCUMENT</span></div>` +
      this.colorField(this.t('inspector.background'), 'background', st.doc.background, true) +
      `<p class="field-hint">${this.escapeHtml(this.t('inspector.backgroundHint'))}</p><div class="doc-stat-grid">` +
      `<button type="button" class="doc-stat doc-stat-button" data-action="open-canvas-size" title="${this.escapeHtml(this.t('canvas.changeSize'))}"><strong id="docSizeStat">${st.doc.width} × ${st.doc.height}</strong><span>${this.escapeHtml(this.t('inspector.canvasSizeStat'))}</span></button>` +
      `<div class="doc-stat"><strong>${st.doc.shapes.length}</strong><span>${this.escapeHtml(this.t('inspector.shapeCount'))}</span></div></div></div>` +
      `<div class="shortcut-card" data-rail-section="shortcuts"><h3>${this.escapeHtml(this.t('inspector.shortcuts'))}</h3>` +
      `<div><span>${this.escapeHtml(this.t('inspector.addRectEllipse'))}</span><span><kbd>R</kbd> <kbd>O</kbd></span></div>` +
      `<div><span>${this.escapeHtml(this.t('inspector.addCirclePolygon'))}</span><span><kbd>C</kbd> <kbd>G</kbd></span></div>` +
      `<div><span>${this.escapeHtml(this.t('inspector.addLinePath'))}</span><span><kbd>L</kbd> <kbd>P</kbd></span></div>` +
      `<div><span>${this.escapeHtml(this.t('inspector.addText'))}</span><span><kbd>T</kbd></span></div>` +
      `<div><span>${this.escapeHtml(this.t('inspector.duplicateShortcut'))}</span><span><kbd>Ctrl</kbd> <kbd>D</kbd></span></div>` +
      `<div><span>${this.escapeHtml(this.t('inspector.exportShortcut'))}</span><span><kbd>Ctrl</kbd> <kbd>S</kbd></span></div>` +
      '</div></div>'
  }

  /** 拖动期间只回写数字，不重建 DOM；焦点在数值输入框上时完全跳过 */
  syncInspectorValues(): void {
    const st = this.state
    const selected = this.selectedShapes()
    if (selected.length > 1) {
      const p = this.el('inspector').querySelector('.multi-head p')
      if (p) {
        const box = unionBoxes(selected.map((s) => this.shapeBox(s))) ?? { w: 0, h: 0 }
        p.textContent = this.t('selection.subtitle', { w: Math.round(box.w), h: Math.round(box.h) })
      }
      return
    }
    const shape = selected[0]
    if (!shape) return
    const active = document.activeElement as Element | null
    if (active && typeof active.matches === 'function' && active.matches('[data-prop], [data-cmd-key]')) return
    const numericByType: Partial<Record<ShapeType, string[]>> = {
      rect: ['x', 'y', 'w', 'h', 'rx'],
      ellipse: ['cx', 'cy', 'rx', 'ry'],
      circle: ['cx', 'cy', 'r'],
      line: ['x1', 'y1', 'x2', 'y2']
    }
    for (const prop of numericByType[shape.type] ?? []) {
      const input = this.el('inspector').querySelector<HTMLInputElement>(`input[data-prop="${prop}"]`)
      if (input) input.value = fmt2(Number((shape as unknown as Record<string, number>)[prop]))
    }
    if (shape.type === 'path' && st.selectedCmdId) {
      const cmd = shape.commands.find((c) => c.id === st.selectedCmdId)
      if (cmd) {
        for (const el of Array.from(this.el('inspector').querySelectorAll<HTMLInputElement>('[data-cmd-key]'))) {
          const key = el.dataset.cmdKey!
          if (el.dataset.cmdId === cmd.id) {
            const v = Number((cmd as unknown as Record<string, number>)[key])
            if (Number.isFinite(v)) el.value = fmt2(v)
          }
        }
      }
    }
  }
  /* ================= 导出 / 复制 ================= */

  /**
   * 导出前的字体闸门（文件版）：
   *   文字层没指定字体 → toast.fontNotChosen 并中止；
   *   指定了但内存里没有 → 从最近字体的数据目录副本重读；解析不了 → toast.fontMissing 并中止。
   */
  async ensureFontsForText(): Promise<boolean> {
    const st = this.state
    if (!st.doc) return false
    const texts = st.doc.shapes.filter((s) => s.type === 'text') as Array<Shape & { type: 'text' }>
    const missing: string[] = []
    for (const shape of texts) {
      if (!shape.fontFamily) {
        this.toast(this.t('toast.fontNotChosen', { name: shape.name }))
        return false
      }
      if (!st.fonts.has(shape.fontFamily)) {
        const ok = await this.loadFontFromDataDir(shape.fontFamily)
        if (!ok) missing.push(shape.fontDisplay || shape.fontFamily)
      }
    }
    if (missing.length > 0) {
      this.toast(this.t('toast.fontMissing', { name: missing[0]! }))
      return false
    }
    if (texts.length > 0) this.renderShapeLayer()
    return true
  }

  buildSvgText(): string | null {
    const st = this.state
    if (!st.doc) return null
    if (st.source) {
      const patched = exportPatched({
        source: st.source,
        doc: st.doc,
        untitledText: this.t('doc.untitled'),
        fontsOf: (ps) => this.state.fonts.get(ps) ?? null
      })
      if (patched) return patched
    }
    return exportFromModel(st.doc, this.t('doc.untitled'), (ps) => this.state.fonts.get(ps) ?? null)
  }

  /** 文件名清洗：只换 Windows 不允许的 9 个字符，连续并一个 -；空回落 albedo-svg */
  exportFileName(): string {
    const name = (this.state.doc?.name || 'albedo-svg').trim().replace(/[\\/:*?"<>|]+/g, '-')
    return (name || 'albedo-svg') + '.svg'
  }

  async saveSvg(): Promise<void> {
    const st = this.state
    if (!st.doc) return
    this.commitEdit()
    if (!(await this.ensureFontsForText())) return
    const text = this.buildSvgText()
    if (text === null) return
    const path = await this.api.dialog.saveFile({
      title: this.t('action.exportSvg'),
      defaultPath: this.exportFileName(),
      filters: [{ name: 'SVG', extensions: ['svg'] }]
    })
    if (!path) return
    try {
      await this.api.fs.write(path, text)
      this.toast(this.t('toast.svgExported'))
    } catch (err) {
      this.toast(this.t('toast.exportFailed', { message: err instanceof Error ? err.message : String(err) }))
    }
  }

  async copySvgText(): Promise<void> {
    const st = this.state
    if (!st.doc) return
    this.commitEdit()
    if (!(await this.ensureFontsForText())) return
    const text = this.buildSvgText()
    if (text === null) return
    try {
      await this.api.clipboard.writeText(text)
      this.toast(this.t('toast.svgCopied'))
    } catch {
      this.toast(this.t('toast.copyFailed'))
    }
  }

  async copyPathData(): Promise<void> {
    const single = this.singleSelected()
    if (!single || single.type !== 'path') return
    try {
      await this.api.clipboard.writeText(commandsToPath(single.commands))
      this.toast(this.t('toast.pathCopied'))
    } catch {
      this.toast(this.t('toast.copyFailedGeneric'))
    }
  }

  /* ================= SVG 导入 ================= */

  /**
   * 导入的 SVG 落成形状。示例文档或空画布时视为"首个来源"：整份接管（画布尺寸跟文件、
   * 示例图形让位）；否则合并进现有画布（来源合并撞 id 时给新树加前缀），尺寸只撑大不缩小。
   * 导入后一律清空选择；"渐变已简化为纯色"只在有渐变计数时追加。
   */
  importSvgText(text: string, fileName: string): boolean {
    const st = this.state
    let parsed: ReturnType<typeof importSvg>
    try {
      parsed = importSvg(text)
    } catch {
      this.toast(this.t('toast.svgInvalid'))
      return false
    }
    if (parsed.shapes.length === 0) {
      this.toast(this.t('toast.svgNoShapes'))
      return false
    }
    this.commitEdit()
    const before = this.snapshot()
    const isStarter = st.starter
    const replacesAll = isStarter || (st.doc?.shapes.length ?? 0) === 0
    const baseName = ((String(fileName || '').replace(/\.svg$/i, '') || '').trim().slice(0, 40)) || this.t('shape.path')
    const shapes: Shape[] = parsed.shapes.map((raw, i) => {
      const withName = { ...raw } as Shape & { sourceKey?: string | null }
      withName.id = makeId('s')
      withName.name = `${baseName} ${i + 1}`
      if (withName.type === 'path') withName.commands = normalizeCommands(withName.commands)
      return withName
    })
    const prevSource = st.source ? this.cloneSource(st.source) : null
    if (replacesAll) st.source = null
    this.adoptImportedSource(parsed, shapes, replacesAll)
    for (const s of shapes) delete (s as { sourceKey?: string }).sourceKey
    this.applyImportedCanvasSize(parsed.source, replacesAll)
    if (st.doc) {
      if (isStarter) st.doc.shapes = []
      if (st.doc.name === this.t('doc.untitled')) {
        st.doc.name = parsed.title ? parsed.title : isStarter ? baseName : st.doc.name
      }
      st.doc.shapes.push(...shapes)
    }
    st.sourceByDoc.set(before, prevSource)
    st.sourceByDoc.set(this.snapshot(), st.source)
    st.sourcePersisted = false
    this.setSelectedIds([])
    st.pathEdit = false
    st.rightTab = 'style'
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    let msg = this.tf('toast.svgImported', shapes.length, {})
    if (parsed.warnings.gradients > 0) msg += ` · ${this.t('toast.svgGradientsFlattened')}`
    this.toast(msg)
    return true
  }

  private cloneSource(src: SourceState): SourceState {
    return { doc: src.doc.cloneNode(true) as Document, root: src.root.cloneNode(true) as Element, entries: new Map(src.entries) }
  }

  private applyImportedCanvasSize(source: { width: number | null; height: number | null }, replacesAll: boolean): void {
    const st = this.state
    if (!st.doc) return
    const w = source.width
    const h = source.height
    if (!Number.isFinite(w as number) || !Number.isFinite(h as number) || (w as number) <= 0 || (h as number) <= 0) return
    if (replacesAll) {
      st.doc.width = clamp(Math.round(w as number), 64, 10000)
      st.doc.height = clamp(Math.round(h as number), 64, 10000)
    } else {
      st.doc.width = clamp(Math.max(st.doc.width, Math.round(w as number)), 64, 10000)
      st.doc.height = clamp(Math.max(st.doc.height, Math.round(h as number)), 64, 10000)
    }
  }

  /** 来源登记：把导入那棵树并进 C.source；已有来源时合并，新树撞 id 就整棵加前缀 */
  private adoptImportedSource(parsed: ReturnType<typeof importSvg>, shapes: Shape[], replacesAll: boolean): void {
    const st = this.state
    if (!parsed.sourceDoc || !parsed.sourceRoot) return
    const byKey = new Map<string, Shape & { sourceKey?: string | null }>()
    for (const shape of shapes) {
      const key = (shape as { sourceKey?: string | null }).sourceKey
      if (key) byKey.set(key, shape as Shape & { sourceKey?: string | null })
    }
    if (byKey.size === 0) return
    let newRoot = parsed.sourceRoot
    let newDoc: Document = parsed.sourceDoc
    if (replacesAll || !st.source) {
      st.source = { doc: newDoc, root: newRoot, entries: new Map() }
    } else {
      st.source = this.cloneSource(st.source)
      st.sourceSerial += 1
      const oldIds = new Set<string>()
      const newIds = new Set<string>()
      for (const el of Array.from(st.source.root.querySelectorAll('[id]'))) oldIds.add(el.id)
      for (const el of Array.from(newRoot.querySelectorAll('[id]'))) newIds.add(el.id)
      const collides = [...newIds].some((id) => oldIds.has(id))
      if (collides) {
        const prefix = makeId('imp') + '-'
        this.namespaceIdsInTree(newRoot, prefix)
        const remap = new Map<string, string>()
        for (const el of Array.from(newRoot.querySelectorAll('[data-albedo-key]'))) {
          const key = el.getAttribute('data-albedo-key')!
          remap.set(key, prefix + key)
          el.setAttribute('data-albedo-key', prefix + key)
        }
        const entries = new Map<string, SourceEntryRecord>()
        for (const [shapeId, record] of st.source.entries) {
          entries.set(shapeId, remap.has(record.key) ? { ...record, key: remap.get(record.key)! } : record)
        }
        st.source.entries = entries
        for (const [, shape] of byKey) {
          if (shape.sourceKey && remap.has(shape.sourceKey)) shape.sourceKey = remap.get(shape.sourceKey)!
        }
      }
      const g = newDoc.createElementNS('http://www.w3.org/2000/svg', 'g')
      const skipAttrs = new Set(['width', 'height', 'viewBox', 'preserveAspectRatio', 'version', 'id', 'x', 'y'])
      for (const attr of Array.from(newRoot.attributes)) {
        if (attr.name === 'xmlns' || attr.name.startsWith('xmlns:') || skipAttrs.has(attr.name)) continue
        g.setAttribute(attr.name, attr.value)
      }
      for (const child of Array.from(newRoot.childNodes)) {
        if (child.nodeType === 1 && (child as Element).nodeName.toLowerCase() === 'title') continue
        g.appendChild(child)
      }
      st.source.root.appendChild(g)
    }
    for (const [key, shape] of byKey) {
      const found = findByAlbedoKey(st.source!.root, key)
      const ancestorOpacity = found ? ancestorOpacityProduct(found) : 1
      st.source!.entries.set(shape.id, { key, baseline: shapeSignature(shape), ancestorOpacity })
    }
  }

  /** 整棵树换 id 前缀，并改写 url(#…) 与 href="#…" 引用 */
  private namespaceIdsInTree(root: Element, prefix: string): void {
    const map = new Map<string, string>()
    for (const el of Array.from(root.querySelectorAll('[id]'))) {
      const next = prefix + el.id
      map.set(el.id, next)
      el.id = next
    }
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (/^url\(#.+\)$/.test(attr.value)) {
          const inner = attr.value.slice(5, -1)
          const next = map.get(inner)
          if (next) el.setAttribute(attr.name, `url(#${next})`)
        } else if ((attr.name === 'href' || attr.name.endsWith(':href')) && attr.value.startsWith('#')) {
          const next = map.get(attr.value.slice(1))
          if (next) el.setAttribute(attr.name, `#${next}`)
        }
      }
    }
  }

  /** 系统对话框挑 SVG 文件（fs.read 由对话框授权） */
  async openSvgPicker(): Promise<void> {
    this.toast(this.t('toast.readingSvg'))
    const paths = await this.api.dialog.openFiles({
      title: this.t('action.importSvg'),
      filters: [{ name: 'SVG', extensions: ['svg'] }]
    })
    const path = paths?.[0]
    if (!path) {
      this.toast(this.t('toast.chooseSvg'))
      return
    }
    try {
      const bytes = await this.api.fs.read(path)
      const text = new TextDecoder('utf-8').decode(bytes)
      const name = path.split(/[\\/]/).pop() || 'import.svg'
      this.importSvgText(text, name)
    } catch {
      this.toast(this.t('toast.svgReadFailed'))
    }
  }

  /** 拖放进来的文件：SVG 走导入，其余按图片读成桌布 */
  async handleDroppedFile(file: File): Promise<void> {
    if (/^image\/svg\+xml$/i.test(file.type) || /\.svg$/i.test(file.name || '')) {
      const token = ++this.state.svgImportToken
      this.toast(this.t('toast.readingSvg'))
      try {
        const text = await file.text()
        if (token !== this.state.svgImportToken) return
        this.importSvgText(text, file.name || 'import.svg')
      } catch {
        if (token === this.state.svgImportToken) this.toast(this.t('toast.svgReadFailed'))
      }
      return
    }
    await this.importUnderlayFromFile(file)
  }

  /* ================= 桌布图片导入 ================= */

  async pickUnderlayImage(): Promise<void> {
    const paths = await this.api.dialog.openFiles({
      title: this.t('underlay.import'),
      filters: [{ name: this.t('underlay.import'), extensions: ['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico'] }]
    })
    const path = paths?.[0]
    if (!path) {
      this.toast(this.t('toast.chooseImage'))
      return
    }
    try {
      const bytes = await this.api.fs.read(path)
      const name = path.split(/[\\/]/).pop() || ''
      const extOk = /\.(png|jpe?g|jfif|webp|gif|svg|avif|bmp|ico)$/i.test(name)
      await this.importUnderlayFromBytes(bytes, name, extOk ? `image/${(name.split('.').pop() ?? 'png').toLowerCase().replace('jpg', 'jpeg')}` : 'image/png')
    } catch {
      this.toast(this.t('toast.imageReadFailed'))
    }
  }

  async importUnderlayFromFile(file: File): Promise<void> {
    const typeOk = /^image\//i.test(file.type)
    const nameOk = /\.(png|jpe?g|jfif|webp|gif|svg|avif|bmp|ico)$/i.test(file.name || '')
    if (!typeOk && !nameOk) {
      this.toast(this.t('toast.chooseImage'))
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await this.importUnderlayFromBytes(bytes, file.name || '', file.type || 'image/png')
    } catch {
      this.toast(this.t('toast.imageReadFailed'))
    }
  }

  /** dataURL 编码后交给 Image 量尺寸；读得出尺寸才立桌布；透明度沿用旧桌布的 */
  private async importUnderlayFromBytes(bytes: Uint8Array, name: string, mime: string): Promise<void> {
    const st = this.state
    if (!st.doc) return
    const token = ++st.underlayImportToken
    this.toast(this.t('toast.readingUnderlay'))
    let dataUrl: string
    try {
      dataUrl = bufferToDataUrl(bytes, mime)
    } catch {
      if (token === st.underlayImportToken) this.toast(this.t('toast.imageReadFailed'))
      return
    }
    if (token !== st.underlayImportToken) return
    const size = await this.readImageSize(dataUrl, bytes)
    if (token !== st.underlayImportToken) return
    if (!size) {
      this.toast(this.t('toast.imageNoSize'))
      return
    }
    const doc = st.doc
    const scale = Math.min(doc.width / Math.max(1, size.w), doc.height / Math.max(1, size.h))
    const w = Math.max(1, size.w * scale)
    const h = Math.max(1, size.h * scale)
    st.underlay = {
      name: name || this.t('underlay.defaultName'),
      src: dataUrl,
      x: (doc.width - w) / 2,
      y: (doc.height - h) / 2,
      w,
      h,
      naturalW: size.w,
      naturalH: size.h,
      opacity: st.underlay?.opacity ?? 0.85,
      visible: true
    }
    st.underlayAdjust = true
    st.underlayWarned = false
    st.underlayPersistFailed = false
    this.setSelectedIds([])
    this.fullRefresh()
    this.setUnderlayPopover(true)
    this.toast(this.t('toast.underlayImported'))
    await this.persistUnderlayNow()
  }

  private readImageSize(dataUrl: string, bytes: Uint8Array): Promise<{ w: number; h: number } | null> {
    const sniffed = sniffImageSize(bytes)
    if (sniffed) return Promise.resolve(sniffed)
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null)
      img.onerror = () => resolve(null)
      img.src = dataUrl
    })
  }

  /* ================= 字体文件（选择 / 复制存盘 / 重读） ================= */

  /** 文字层"选择字体"：系统文件框挑字体 → 解析 → 复制进数据目录 → 注册显示 → 写进形状 */
  async chooseFontFileForText(): Promise<void> {
    const st = this.state
    const single = this.singleSelected()
    if (!single || single.type !== 'text') return
    if (st.fontBusy) return
    st.fontBusy = true
    try {
      const paths = await this.api.dialog.openFiles({
        title: this.t('font.pickTitle'),
        filters: [{ name: 'Font', extensions: ['ttf', 'otf', 'ttc'] }]
      })
      const path = paths?.[0]
      if (!path) return
      const bytes = await this.api.fs.read(path)
      const buffer = bytesToArrayBuffer(bytes)
      const name = path.split(/[\\/]/).pop() || 'font'
      await this.applyFontBuffer(buffer, name)
    } finally {
      st.fontBusy = false
    }
  }

  async applyFontBuffer(buffer: ArrayBuffer, fileName: string): Promise<void> {
    const st = this.state
    const single = this.singleSelected()
    if (!single || single.type !== 'text') return
    let parsed: ParsedFont
    try {
      parsed = parseFontBuffer(buffer, '')
    } catch {
      this.toast(this.t('toast.fontFailed', { name: fileName }))
      return
    }
    const ps = fontPostscriptName(parsed.font)
    const family = fontFamilyName(parsed.font)
    const style = fontSubfamilyName(parsed.font)
    try {
      await this.registerFont(parsed, ps, family)
    } catch {
      /* 注册显示失败不影响导出侧：opentype 已解析成功 */
    }
    const file = `font-${ps.replace(/[^A-Za-z0-9_-]/g, '-') || 'face'}.${fileName.split('.').pop()?.toLowerCase() || 'ttf'}`
    try {
      const abs = await this.api.fs.resolveInData('fonts', file)
      await this.api.fs.write(abs, new Uint8Array(buffer))
      this.pushRecentFont({ postscriptName: ps, family, style, file })
    } catch {
      /* 存不进数据目录：本次会话仍可用，只是重启后要重新选 */
    }
    this.commitEdit()
    const before = this.snapshot()
    single.fontFamily = ps
    single.fontDisplay = [family, style].filter(Boolean).join(' ')
    this.pushHistory(before)
    this.fullRefresh()
    this.scheduleSave()
    this.toast(this.t('toast.fontApplied', { name: single.fontDisplay || ps }))
  }

  private async registerFont(parsed: ParsedFont, ps: string, family: string): Promise<void> {
    const cssFamily = cssFamilyFor(ps)
    await registerCssFont(cssFamily, parsed.faceBuffer, family)
    this.state.fonts.set(ps, { font: parsed.font as unknown as FontEntry['font'], cssFamily, family, style: '' })
  }

  /** 从数据目录副本重读字体（跨会话导出用）；读不到返回 false 交给调用方念"缺少字体" */
  async loadFontFromDataDir(ps: string): Promise<boolean> {
    const st = this.state
    const recent = st.recentFonts.find((r) => r.postscriptName === ps)
    if (!recent) return false
    try {
      const abs = await this.api.fs.resolveInData('fonts', recent.file)
      const bytes = await this.api.fs.read(abs)
      const parsed = parseFontBuffer(bytesToArrayBuffer(bytes), ps)
      await this.registerFont(parsed, ps, recent.family)
      const entry = st.fonts.get(ps)
      if (entry) entry.style = recent.style
      return true
    } catch {
      return false
    }
  }
  /* ================= 事件接线 ================= */

  private bindUi(): void {
    const st = this.state
    const opts = this.listenOpts

    ;(this.el('langSelect') as HTMLSelectElement).addEventListener('change', () => this.setLang((this.el('langSelect') as HTMLSelectElement).value as 'auto' | 'zh' | 'en'), opts)
    this.win.addEventListener('languagechange', () => {
      if (st.langMode === 'auto') this.setLang('auto', { persist: false })
    }, opts)
    this.el('undoBtn').addEventListener('click', () => this.undoAction(), opts)
    this.el('redoBtn').addEventListener('click', () => this.redoAction(), opts)
    this.el('newBtn').addEventListener('click', () => this.newBlankDocument(), opts)
    this.el('copyBtn').addEventListener('click', () => void this.copySvgText(), opts)
    this.el('exportBtn').addEventListener('click', () => void this.saveSvg(), opts)
    ;(this.el('docTitle') as HTMLInputElement).addEventListener('input', () => this.commitDocName(), opts)
    ;(this.el('docTitle') as HTMLInputElement).addEventListener('blur', () => {
      const input = this.el('docTitle') as HTMLInputElement
      if (!input.value.trim()) input.value = this.t('doc.untitled')
      this.commitDocName()
    }, opts)
    for (const btn of Array.from(this.host.querySelectorAll<HTMLElement>('.shape-btn'))) {
      btn.addEventListener('click', () => this.addShape(btn.dataset.add as ShapeType | undefined), opts)
    }
    this.el('importSvgBtn').addEventListener('click', () => void this.openSvgPicker(), opts)
    this.el('insertSvgBtn').addEventListener('click', () => void this.openSvgPicker(), opts)

    this.bindRailNav(this.el('leftRail'), (section) => this.showLeftTab(section))
    this.bindRailNav(this.el('inspectorRail'), (section) => this.showInspectorTab(section))

    this.el('gridToggle').addEventListener('click', () => {
      st.grid.visible = !st.grid.visible
      this.syncToolbarToggles()
      this.renderGrid()
    }, opts)
    ;(this.el('gridSize') as HTMLSelectElement).addEventListener('change', () => {
      const v = Number((this.el('gridSize') as HTMLSelectElement).value)
      st.grid.size = (GRID_SIZES as readonly number[]).includes(v) ? v : 8
      this.renderGrid()
    }, opts)
    this.el('snapToggle').addEventListener('click', () => {
      st.snapEnabled = !st.snapEnabled
      this.syncToolbarToggles()
      if (!st.snapEnabled) {
        st.snapGuides = []
        this.renderOverlay()
      }
    }, opts)

    this.el('underlayImportBtn').addEventListener('click', () => void this.pickUnderlayImage(), opts)
    this.el('underlayReplaceBtn').addEventListener('click', () => void this.pickUnderlayImage(), opts)
    this.el('underlayToggle').addEventListener('click', () => this.setUnderlayPopover(this.el('underlayPopover').hidden), opts)
    this.el('underlayPopoverClose').addEventListener('click', () => this.setUnderlayPopover(false), opts)
    document.addEventListener('pointerdown', (e) => {
      if (this.el('underlayPopover').hidden) return
      if (this.el('underlayPopover').contains(e.target as Node) || this.el('underlayToggle').contains(e.target as Node)) return
      this.setUnderlayPopover(false)
    }, opts)
    this.el('underlayVisibleBtn').addEventListener('click', () => this.toggleUnderlayVisible(), opts)
    this.el('underlayAdjustBtn').addEventListener('click', () => {
      const on = !st.underlayAdjust
      this.setUnderlayAdjust(on)
      if (!on) this.toast(this.t('toast.underlayFixed'))
    }, opts)
    this.el('underlayRemoveBtn').addEventListener('click', () => this.removeUnderlay(), opts)

    this.el('canvasSizeBtn').addEventListener('click', () => this.openCanvasModal(this.el('canvasSizeBtn')), opts)
    this.el('zoomInBtn').addEventListener('click', () => this.setZoom(stepZoom(st.zoom, 1), this.viewportCenter()), opts)
    this.el('zoomOutBtn').addEventListener('click', () => this.setZoom(stepZoom(st.zoom, -1), this.viewportCenter()), opts)
    this.el('zoomFitBtn').addEventListener('click', () => this.setZoom(1), opts)
    this.el('stageBody').addEventListener(
      'wheel',
      (e) => {
        const ev = e as WheelEvent
        if (!(ev.ctrlKey || ev.metaKey)) return
        ev.preventDefault()
        this.setZoom(clampZoom(st.zoom * zoomFromWheel(ev.deltaY)), { x: ev.clientX, y: ev.clientY })
      },
      { ...opts, passive: false }
    )

    this.el('canvasModal').addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const preset = target.closest<HTMLElement>('[data-preset]')
      if (preset) {
        const [w, h] = preset.dataset.preset!.split(',')
        ;(this.el('canvasWidthInput') as HTMLInputElement).value = w!
        ;(this.el('canvasHeightInput') as HTMLInputElement).value = h!
        this.syncCanvasModal()
        ;(this.el('canvasWidthInput') as HTMLInputElement).focus()
        return
      }
      if (target.closest('[data-close-canvas]')) this.closeCanvasModal()
    }, opts)
    for (const input of [this.el('canvasWidthInput'), this.el('canvasHeightInput')]) {
      input.addEventListener('input', () => this.syncCanvasModal(), opts)
    }
    this.el('canvasApplyBtn').addEventListener('click', () => this.applyCanvasSize(), opts)

    this.el('stage').addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent
      if (ev.button !== 0) return
      const shapeEl = (ev.target as Element).closest?.('.shape') as HTMLElement | null
      if (shapeEl) {
        const shape = this.findShape(shapeEl.dataset.id ?? null)
        if (!shape) return
        if (ev.shiftKey || ev.ctrlKey || ev.metaKey) {
          this.selectShape(shape.id, { additive: true, keepPathEdit: false })
          return
        }
        if (!st.selectedIds.includes(shape.id)) this.selectShape(shape.id, { keepPathEdit: false })
        this.startMove(ev)
        return
      }
      if (ev.target === this.el('stage') || ev.target === this.el('canvasBg')) {
        if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey)) this.selectShape(null)
        this.startMarquee(ev)
      }
    }, opts)
    this.el('stage').addEventListener('pointermove', (e) => {
      if (st.gesture) return
      this.renderPointerCoord(this.eventToDoc(e as PointerEvent))
    }, opts)
    this.el('overlay').addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent
      if (ev.button !== 0) return
      const target = ev.target as Element
      const underlay = target.closest?.('[data-underlay]') as HTMLElement | null
      if (underlay) {
        ev.preventDefault()
        ev.stopPropagation()
        this.startUnderlayDrag(ev, underlay.dataset.underlay)
        return
      }
      const node = target.closest?.('[data-node]') as HTMLElement | null
      if (node) {
        ev.preventDefault()
        ev.stopPropagation()
        this.startNodeDrag(ev, node.dataset.cmd, node.dataset.node === 'control' ? node.dataset.part ?? 'c' : 'anchor')
        return
      }
      const handle = target.closest?.('[data-handle]') as HTMLElement | null
      if (handle) {
        ev.preventDefault()
        ev.stopPropagation()
        this.startResize(ev, handle.dataset.handle!)
      }
    }, opts)

    const filesInDrag = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    this.el('stageBody').addEventListener('dragover', (e) => {
      const ev = e as DragEvent
      if (!filesInDrag(ev)) return
      ev.preventDefault()
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
      this.el('stageBody').classList.add('is-drop')
    }, opts)
    this.el('stageBody').addEventListener('dragleave', (e) => {
      const ev = e as DragEvent
      if (!ev.relatedTarget || !this.el('stageBody').contains(ev.relatedTarget as Node)) this.el('stageBody').classList.remove('is-drop')
    }, opts)
    this.el('stageBody').addEventListener('drop', (e) => {
      const ev = e as DragEvent
      if (!filesInDrag(ev)) return
      ev.preventDefault()
      this.el('stageBody').classList.remove('is-drop')
      const file = Array.from(ev.dataTransfer?.files ?? [])[0]
      if (file) void this.handleDroppedFile(file)
    }, opts)
    this.win.addEventListener('dragover', (e) => {
      if (filesInDrag(e as DragEvent)) (e as DragEvent).preventDefault()
    }, opts)
    this.win.addEventListener('drop', (e) => {
      const ev = e as DragEvent
      if (!filesInDrag(ev)) return
      ev.preventDefault()
      if (!this.el('stageBody').contains(ev.target as Node)) {
        this.el('stageBody').classList.remove('is-drop')
        this.toast(this.t('toast.dropImage'))
      }
    }, opts)

    this.el('layers').addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const actionEl = target.closest<HTMLElement>('[data-layer-action]')
      const row = target.closest<HTMLElement>('[data-layer-id]')
      if (!row) return
      const id = row.dataset.layerId!
      if (actionEl) {
        e.stopPropagation()
        const action = actionEl.dataset.layerAction
        if (action === 'delete') this.deleteShapeById(id)
        if (action === 'up') this.moveLayerBy(id, 1)
        if (action === 'down') this.moveLayerBy(id, -1)
        return
      }
      const ev = e as MouseEvent
      this.selectShape(id, { additive: ev.shiftKey || ev.ctrlKey || ev.metaKey, keepPathEdit: false, scrollLayer: false })
    }, opts)
    this.el('layers').addEventListener('dragstart', (e) => {
      const ev = e as DragEvent
      const row = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-layer-id]')
      if (!row) return
      st.layerDrag = row.dataset.layerId ?? null
      row.classList.add('dragging')
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move'
        try {
          ev.dataTransfer.setData('text/plain', row.dataset.layerId ?? '')
        } catch {
          /* jsdom 没有 DataTransfer：状态记在 layerDrag 就够用 */
        }
      }
    }, opts)
    this.el('layers').addEventListener('dragover', (e) => {
      const ev = e as DragEvent
      const row = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-layer-id]')
      if (!row || !st.layerDrag) return
      ev.preventDefault()
      for (const r of Array.from(this.el('layers').querySelectorAll('.layer-row'))) r.classList.remove('drop-above', 'drop-below')
      const rect = row.getBoundingClientRect()
      row.classList.add(ev.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below')
    }, opts)
    this.el('layers').addEventListener('drop', (e) => {
      const ev = e as DragEvent
      const row = (ev.target as HTMLElement).closest?.<HTMLElement>('[data-layer-id]')
      if (!row || !st.layerDrag) return
      ev.preventDefault()
      const rect = row.getBoundingClientRect()
      const below = ev.clientY >= rect.top + rect.height / 2
      const dragId = st.layerDrag
      st.layerDrag = null
      this.moveLayerTo(dragId, row.dataset.layerId!, !below)
    }, opts)
    this.el('layers').addEventListener('dragend', () => {
      st.layerDrag = null
      for (const r of Array.from(this.el('layers').querySelectorAll('.layer-row'))) r.classList.remove('dragging', 'drop-above', 'drop-below')
    }, opts)

    this.bindInspectorEvents()

    this.win.addEventListener('keydown', (e) => this.onKeyDown(e as KeyboardEvent), opts)
    this.win.addEventListener('blur', () => {
      if (st.gesture) this.onPointerEnd(new PointerEvent('pointerup'))
    }, opts)
    this.win.addEventListener('beforeunload', () => {
      this.commitEdit()
      void this.saveNow()
      void this.persistUnderlayNow()
    }, opts)
    this.win.addEventListener('resize', () => {
      this.layoutStage()
      this.refreshRails()
    }, opts)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => this.layoutStage())
      ro.observe(this.el('stageBody'))
      this.resizeObserver = ro
    }
  }

  private resizeObserver: ResizeObserver | null = null

  private bindInspectorEvents(): void {
    const st = this.state
    const inspector = this.el('inspector')
    const opts = this.listenOpts

    inspector.addEventListener('click', (e) => {
      const target = e.target as HTMLElement
      const underlayAction = target.closest<HTMLElement>('[data-underlay-action]')
      if (underlayAction) {
        e.preventDefault()
        this.runUnderlayCommand(underlayAction.dataset.underlayAction!)
        return
      }
      const bool = target.closest<HTMLElement>('[data-boolean]')
      if (bool && !(bool as HTMLButtonElement).disabled) {
        this.applyBoolean(bool.dataset.boolean!)
        return
      }
      const align = target.closest<HTMLElement>('[data-align]')
      if (align && !(align as HTMLButtonElement).disabled) {
        this.alignSelection(align.dataset.align!)
        return
      }
      const distribute = target.closest<HTMLElement>('[data-distribute]')
      if (distribute && !(distribute as HTMLButtonElement).disabled) {
        this.distributeSelection(distribute.dataset.distribute as 'x' | 'y')
        return
      }
      const action = target.closest<HTMLElement>('[data-action]')
      if (action) {
        const name = action.dataset.action
        if (name === 'delete') this.deleteSelection()
        if (name === 'duplicate') this.duplicateSelection()
        if (name === 'choose-font') void this.chooseFontFileForText()
        if (name === 'open-canvas-size') {
          this.openCanvasModal(action)
          return
        }
        if (name === 'toggle-path-edit') {
          st.pathEdit = (action as HTMLInputElement).checked
          this.renderOverlay()
          this.renderStatus()
          return
        }
        return
      }
      const setNone = target.closest<HTMLElement>('[data-set-none]')
      if (setNone) {
        const prop = setNone.dataset.setNone!
        this.commitEdit()
        const before = this.snapshot()
        if (prop === 'background') st.doc!.background = 'none'
        else {
          const single = this.singleSelected() as Record<string, unknown> | null
          if (single) single[prop] = 'none'
        }
        this.pushHistory(before)
        this.fullRefresh()
        this.scheduleSave()
        return
      }
      const addCmd = target.closest<HTMLElement>('[data-add-cmd]')
      if (addCmd) {
        this.addPathCommand(addCmd.dataset.addCmd)
        return
      }
      const delCmd = target.closest<HTMLElement>('[data-del-cmd]')
      if (delCmd) {
        e.stopPropagation()
        this.deletePathCommand(delCmd.dataset.delCmd!)
        return
      }
      if (target.closest('[data-copy-path]')) {
        void this.copyPathData()
        return
      }
      const selectCmd = target.closest<HTMLElement>('[data-select-cmd]')
      if (selectCmd) this.selectCommand(selectCmd.dataset.selectCmd!, true)
    }, opts)

    inspector.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement
      if (input.matches?.('input[data-action="toggle-path-edit"]')) {
        st.pathEdit = input.checked
        this.renderOverlay()
        this.renderStatus()
        return
      }
      if (input.matches?.('[data-poly-sides]')) {
        const single = this.singleSelected()
        if (!single || single.type !== 'polygon') return
        const raw = parseFloat(input.value)
        if (!Number.isFinite(raw)) {
          this.renderInspector()
          return
        }
        const sides = clamp(Math.round(raw), 3, 24)
        if (sides === single.points.length) {
          input.value = String(sides)
          return
        }
        this.commitEdit()
        const before = this.snapshot()
        const fit = pointCloudFit(single.points)
        single.points = regularPolygonPoints(fit.cx, fit.cy, fit.radius, sides, fit.startAngle)
        this.pushHistory(before)
        this.fullRefresh()
        this.scheduleSave()
        this.toast(this.t('toast.polygonSides', { n: sides }))
      }
    }, opts)

    inspector.addEventListener('input', (e) => {
      const input = e.target as HTMLInputElement
      if (input.matches?.('[data-underlay-opacity]')) {
        const u = st.underlay
        if (!u) return
        const v = parseFloat(input.value)
        if (!Number.isFinite(v)) return
        u.opacity = clamp(v, 0.05, 1)
        this.updateUnderlayImage()
        const label = this.el('inspector').querySelector('#underlayOpacityLabel')
        if (label) label.textContent = `${Math.round(u.opacity * 100)}%`
        this.scheduleUnderlaySave()
        return
      }
      if (input.matches?.('[data-underlay-prop]')) {
        const v = parseFloat(input.value)
        if (Number.isFinite(v)) this.setUnderlayProp(input.dataset.underlayProp!, v)
        return
      }
      if (input.matches?.('[data-poly-point]')) {
        const single = this.singleSelected()
        if (!single || single.type !== 'polygon') return
        const index = Number(input.dataset.polyPoint)
        const axis = input.dataset.polyAxis
        const point = single.points[index]
        const v = parseFloat(input.value)
        if (!point || (axis !== 'x' && axis !== 'y') || !Number.isFinite(v)) return
        this.beginEdit()
        point[axis] = v
        this.renderShapeLayer()
        this.scheduleSave()
        return
      }
      if (input.matches?.('input[type="color"][data-prop]')) {
        const prop = input.dataset.prop!
        this.beginEdit()
        this.setShapeProp(input, prop, input.value)
        const hex = input.closest('.color-control')?.querySelector<HTMLInputElement>('[data-color-text]')
        if (hex) hex.value = input.value.toUpperCase()
        const swatch = input.closest('.swatch')
        if (swatch) {
          swatch.classList.remove('is-none')
          ;(swatch as HTMLElement).style.setProperty('--swatch', input.value)
        }
        return
      }
      if (input.matches?.('[data-color-text]')) {
        const value = input.value.trim()
        if (/^#[0-9a-fA-F]{6}$/.test(value) || value === '') {
          if (value === '') return
          this.beginEdit()
          this.setShapeProp(input, input.dataset.prop!, value)
          const swatch = input.closest('.color-control')?.querySelector('.swatch')
          if (swatch) {
            swatch.classList.remove('is-none')
            ;(swatch as HTMLElement).style.setProperty('--swatch', value)
          }
        }
        return
      }
      if (input.matches?.('[data-cmd-flag]')) {
        const cmdId = (input as HTMLInputElement).dataset.cmdId!
        const single = this.singleSelected()
        if (!single || single.type !== 'path') return
        const cmd = single.commands.find((c) => c.id === cmdId)
        if (!cmd) return
        this.beginEdit()
        ;(cmd as unknown as Record<string, number>)[input.dataset.cmdFlag!] = input.checked ? 1 : 0
        this.renderShapeLayer()
        const code = this.el('inspector').querySelector('#pathCode')
        if (code) code.textContent = commandsToPath(single.commands)
        this.scheduleSave()
        return
      }
      if (input.matches?.('[data-cmd-key]')) {
        const cmdId = input.dataset.cmdId!
        const single = this.singleSelected()
        if (!single || single.type !== 'path') return
        const cmd = single.commands.find((c) => c.id === cmdId)
        if (!cmd) return
        let v = parseFloat(input.value)
        if (!Number.isFinite(v)) return
        const key = input.dataset.cmdKey!
        if (cmd.type === 'A' && (key === 'rx' || key === 'ry')) {
          v = Math.max(0.5, Math.abs(v))
          input.value = fmt2(v)
        }
        this.beginEdit()
        ;(cmd as unknown as Record<string, number>)[key] = v
        this.renderShapeLayer()
        const code = this.el('inspector').querySelector('#pathCode')
        if (code) code.textContent = commandsToPath(single.commands)
        const coords = input.closest('.cmd-card')?.querySelector('.cmd-coords')
        if (coords) {
          coords.textContent =
            cmd.type === 'Z' ? 'CLOSE' : `${Math.round((cmd as { x?: number }).x ?? 0)}, ${Math.round((cmd as { y?: number }).y ?? 0)}`
        }
        this.scheduleSave()
        return
      }
      if (input.matches?.('[data-prop]')) {
        const prop = input.dataset.prop!
        let value: string | number
        if (input.dataset.cast === 'number' || input.type === 'number' || input.type === 'range') {
          const n = parseFloat(input.value)
          if (!Number.isFinite(n)) return
          value = n
        } else {
          value = input.value
        }
        this.beginEdit()
        this.setShapeProp(input, prop, value)
      }
    }, opts)

    inspector.addEventListener('focusout', (e) => {
      this.handleInspectorFocusOut(e.target as HTMLElement)
    }, opts)
  }

  /** 输入框离开焦点：收合并编辑 + 立刻落盘，并回填规范值（与单文件版 focusout 同职责） */
  handleInspectorFocusOut(el: HTMLElement): void {
    const st = this.state
    if (el.matches?.('[data-underlay-prop]') && st.underlay) {
      const input = el as HTMLInputElement
      input.value = fmt2(st.underlay[input.dataset.underlayProp as 'x' | 'y' | 'w' | 'h'])
      void this.persistUnderlayNow()
      return
    }
    if (el.matches?.('[data-underlay-opacity]')) {
      void this.persistUnderlayNow()
      return
    }
    if (el.matches?.('[data-color-text], [data-prop], [data-cmd-key], [data-poly-point]')) {
      if (el.matches?.('[data-poly-point]')) {
        const input = el as HTMLInputElement
        const single = this.singleSelected()
        const point = single?.type === 'polygon' ? single.points[Number(input.dataset.polyPoint)] : null
        const axis = input.dataset.polyAxis
        if (point && (axis === 'x' || axis === 'y')) input.value = fmt2(point[axis])
      }
      this.commitEdit()
      void this.saveNow()
      if (el.matches?.('[data-color-text]')) {
        const v = (el as HTMLInputElement).value.trim()
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) this.renderInspector()
      }
    }
  }
  /* ================= 全局键盘 ================= */

  onKeyDown(e: KeyboardEvent): void {
    const st = this.state
    const target = e.target as HTMLElement | null
    if (!this.el('canvasModal').hidden) {
      if (e.key === 'Escape') {
        e.preventDefault()
        this.closeCanvasModal()
      } else if (e.key === 'Enter' && target instanceof HTMLInputElement) {
        e.preventDefault()
        this.applyCanvasSize()
      }
      return
    }
    const inField =
      !!target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
    const meta = e.metaKey || e.ctrlKey
    const k = e.key.toLowerCase()

    if (meta && k === 'z') {
      e.preventDefault()
      if (e.shiftKey) this.redoAction()
      else this.undoAction()
      return
    }
    if (meta && k === 'y') {
      e.preventDefault()
      this.redoAction()
      return
    }
    if (meta && k === 's') {
      e.preventDefault()
      void this.saveSvg()
      return
    }
    if (meta && k === 'd') {
      e.preventDefault()
      this.duplicateSelection()
      return
    }
    if (meta && (e.key === '=' || e.key === '+' || e.key === 'add')) {
      e.preventDefault()
      this.zoomStep(1)
      return
    }
    if (meta && (e.key === '-' || e.key === '\u2212' || e.key === 'subtract')) {
      e.preventDefault()
      this.zoomStep(-1)
      return
    }
    if (meta && e.key === '0') {
      e.preventDefault()
      this.setZoom(1)
      return
    }
    if (!inField && meta && k === 'a') {
      e.preventDefault()
      this.setSelection((st.doc?.shapes ?? []).map((s) => s.id))
      return
    }
    if (e.key === 'Escape' && st.underlayAdjust) {
      e.preventDefault()
      this.setUnderlayAdjust(false)
      this.toast(this.t('toast.underlayFixed'))
      return
    }
    if (inField) return
    if (e.key === 'Escape') {
      this.selectShape(null)
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (st.selectedIds.length > 0) {
        e.preventDefault()
        this.deleteSelection()
      }
      return
    }
    if (e.key === 'Enter' && st.underlayAdjust && !(target instanceof HTMLButtonElement)) {
      e.preventDefault()
      this.setUnderlayAdjust(false)
      this.toast(this.t('toast.underlayFixed'))
      return
    }
    if (e.key.startsWith('Arrow') && st.underlayAdjust && st.underlay) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      this.nudgeUnderlay(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
      return
    }
    if (e.key === 'Enter' && this.singleSelected()?.type === 'path') {
      e.preventDefault()
      st.pathEdit = !st.pathEdit
      this.renderInspector()
      this.renderOverlay()
      this.renderStatus()
      return
    }
    if (e.key.startsWith('Arrow') && st.selectedId) {
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      this.nudgeSelection(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0)
      return
    }
    if (!meta && !e.altKey) {
      const hot: Record<string, ShapeType> = { r: 'rect', o: 'ellipse', c: 'circle', g: 'polygon', l: 'line', t: 'text', p: 'path' }
      const type = hot[k]
      if (type) this.addShape(type)
    }
  }

  /* ================= 启动与测试钩子 ================= */

  async boot(): Promise<void> {
    const st = this.state
    if (this.booted) return
    this.booted = true
    await this.store.hydrate()
    st.langMode = this.readLangMode()
    st.lang = this.resolveLang(st.langMode)
    this.applyLanguage()
    const loaded = this.loadDocFromStore()
    st.doc = loaded ?? makeStarterDoc(st.lang)
    st.starter = !loaded
    st.source = loaded ? this.loadSourceFromStore() : null
    st.sourcePersisted = !!st.source
    st.recentFonts = this.loadRecentFonts()
    this.localizeDoc()
    if (loaded) {
      this.setSelectedIds([])
    } else {
      const pathShape = st.doc.shapes.find((s) => s.type === 'path')
      if (pathShape) {
        this.setSelectedIds([pathShape.id], pathShape.id)
        st.selectedCmdId = this.preferredCommand(pathShape)?.id ?? null
      }
    }
    st.pathEdit = true
    st.underlay = this.loadUnderlayFromStore()
    this.localizeDoc()
    this.syncDocTitleInput()
    this.bindUi()
    this.syncToolbarToggles()
    this.installTestHooks()
    this.fullRefresh()
    this.syncUndoRedoButtons()
    this.renderPointerCoord({ x: 0, y: 0 })
    void this.api.window.setTitle(st.doc.name).catch(() => undefined)
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => this.layoutStage())
    else this.layoutStage()
    if (!loaded) {
      st.tipTimer = setTimeout(() => {
        st.tipDismissed = true
        this.el('canvasTip').classList.add('hidden')
      }, 9000)
    }
  }

  loadSourceFromStore(): SourceState | null {
    const raw = this.store.getItem(STORE_KEY_SOURCE)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as { svg?: unknown; entries?: unknown }
      if (typeof parsed.svg !== 'string' || !Array.isArray(parsed.entries)) return null
      const doc = new DOMParser().parseFromString(parsed.svg, 'image/svg+xml')
      const root = doc.documentElement
      if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null
      const entries = new Map<string, SourceEntryRecord>()
      for (const item of parsed.entries as Array<[string, { key?: unknown; baseline?: unknown; ancestorOpacity?: unknown }]>) {
        const [shapeId, record] = item
        if (!record || typeof record.key !== 'string' || typeof record.baseline !== 'string') continue
        const ao = Number(record.ancestorOpacity)
        entries.set(shapeId, {
          key: record.key,
          baseline: record.baseline,
          ancestorOpacity: Number.isFinite(ao) ? clamp(ao, 0, 1) : 1
        })
      }
      if (entries.size === 0) return null
      return { doc, root, entries }
    } catch {
      return null
    }
  }

  /** 与单文件版 __ALBEDO_TEST__ 同面的钩子：截图模式与用例都从这里进内部状态 */
  private installTestHooks(): void {
    const w = globalThis as unknown as Record<string, unknown>
    w.__ALBEDO_TEST__ = {
      load: (doc: unknown) => {
        this.commitEdit()
        this.state.doc = normalizeDoc(doc, this.state.lang)
        this.state.starter = false
        this.state.source = null
        this.state.sourceSerial = 0
        this.state.sourceByDoc.clear()
        this.state.sourcePersisted = false
        this.store.removeItem(STORE_KEY_SOURCE)
        this.state.undo = []
        this.state.redo = []
        this.state.underlayAdjust = false
        this.state.snapGuides = []
        this.setSelectedIds([])
        this.syncToolbarToggles()
        this.fullRefresh()
        this.syncUndoRedoButtons()
      },
      doc: () => this.deepClone(this.state.doc),
      selection: () => [...this.state.selectedIds],
      export: async () => {
        this.commitEdit()
        return (await this.ensureFontsForText()) ? this.buildSvgText() : null
      },
      importSvg: (text: string, name?: string) => this.importSvgText(text, name || 'import.svg'),
      tabs: () => ({ left: this.state.leftTab, right: this.state.rightTab }),
      setGrid: (visible: boolean, size: number) => {
        this.state.grid.visible = !!visible
        if ((GRID_SIZES as readonly number[]).includes(Number(size))) this.state.grid.size = Number(size)
        this.syncToolbarToggles()
        this.renderGrid()
      },
      setSnap: (on: boolean) => {
        this.state.snapEnabled = !!on
        this.syncToolbarToggles()
      },
      snapInfo: () => ({ enabled: this.state.snapEnabled, grid: { ...this.state.grid }, uiScale: this.uiScaleOf(), threshold: SNAP_THRESHOLD_PX * this.uiScaleOf() }),
      language: () => ({ mode: this.state.langMode, lang: this.state.lang }),
      setLanguage: (mode: 'auto' | 'zh' | 'en') => this.setLang(mode, { persist: false }),
      /** 截图模式与用例的接缝：jsdom 没有 CTM，选中不经指针事件，直接走这里 */
      select: (id: string | null) => this.selectShape(id, { keepPathEdit: false }),
      pickIds: (indexes: number[]) => {
        const shapes = this.state.doc?.shapes ?? []
        this.setSelection(indexes.map((i) => shapes[i]?.id ?? '').filter(Boolean))
      },
      importUnderlayBytes: async (bytes: Uint8Array, name: string, mime: string) => {
        await this.importUnderlayFromBytes(bytes, name, mime)
      },
      applyFontBytes: async (bytes: Uint8Array, name: string) => {
        await this.applyFontBuffer(bytesToArrayBuffer(bytes), name)
      },
      boolean: (kind: string) => this.applyBoolean(kind),
      exportFileName: () => this.exportFileName(),
      align: (mode: string) => this.alignSelection(mode),
      distribute: (axis: string) => this.distributeSelection(axis as 'x' | 'y')
    }
  }
  /* __CONTINUE__ */
}

const string_: Record<string, unknown> = {}

export const STORE_KEY_DOC = 'doc'
export const STORE_KEY_SOURCE = 'source'
export const STORE_KEY_UNDERLAY = 'underlay'
export const STORE_KEY_LANG = 'lang'
export const STORE_KEY_RECENT_FONTS = 'recentFonts'

export interface SourceState {
  doc: Document
  root: Element
  entries: Map<string, SourceEntryRecord>
}
