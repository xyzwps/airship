import { useMemo, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import { buildIco, describeIco, frameSizesPhrase, ICON_FRAME_SIZES } from './ico.ts'
import { svgToFrames } from './rasterize.ts'
import { looksLikeSvg, svgBox } from './svgFit.ts'
import './airship-icon.css'

/**
 * Icon Helper：一份 SVG 进，`icon.png` 与 `icon.ico` 出（标准见 docs/apps/icons.md）。
 *
 * 三条约束照旧：只引 sdk 与 contract（AP-013）、碰系统只经 `api.`、
 * 配色一律用宿主给的变量。
 *
 * 输入三条来路里，只有「选文件」那条走闸门（`dialog.openFiles` 会把选中路径授一次读）；
 * 拖进来那个 File 对象能不能直接读出字节，是这台机器上的 Electron 行为，用例里验不了——
 * 读不出来时念原话指回「选 SVG 文件」，不静默当没发生。
 */

/** 预览那一排：15 是标题栏那枚记号的真实尺寸，其余是 ico 里的档 */
const PREVIEW_SIZES = [15, 16, 32, 64, 128, 256]
const PNG_MIN = 8
const PNG_MAX = 1024

const NOT_SVG = '那不是 SVG：根标签里没有 <svg>。'
const NO_SOURCE = '先给一份 SVG。'
const NO_PICK = '没选中文件，什么都没改。'
const NO_TARGET = '没选落点，文件没写。'
const DROP_UNREADABLE = '拖进来的那份读不出字节（这个窗口的 File 对象只是张标签）。请改用「选 SVG 文件」，或把源码贴进下面那个框。'
const RANGE_MESSAGE = `PNG 边长要在 ${PNG_MIN} – ${PNG_MAX} px 之间。`

export default function AirshipIconApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()
  const [svg, setSvg] = useState('')
  const [source, setSource] = useState('')
  const [pngSize, setPngSize] = useState('256')
  const [note, setNote] = useState('拖一份 .svg 进来、按「选 SVG 文件」，或把源码贴进下面那个框。')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const usable = looksLikeSvg(svg)
  const box = useMemo(() => (usable ? svgBox(svg) : null), [svg, usable])
  const previewUrl = useMemo(() => (usable ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : ''), [svg, usable])

  function accept(text: string, label: string): void {
    if (!text.trim()) {
      setError(NO_SOURCE)
      return
    }
    if (!looksLikeSvg(text)) {
      setError(NOT_SVG)
      return
    }
    const b = svgBox(text)
    setSvg(text)
    setSource(label)
    setError('')
    setNote(
      b.from === 'fallback'
        ? `这份 SVG 没写 viewBox，也没写数字宽高，按 100 × 100 的方图出。来源：${label}`
        : `原始比例 ${b.width} : ${b.height}（来自${b.from === 'viewBox' ? ' viewBox' : '根标签的 width/height'}）。来源：${label}`
    )
  }

  async function pickFile(): Promise<void> {
    const picked = await api.dialog.openFiles({ title: '选一份 SVG', filters: [{ name: 'SVG', extensions: ['svg'] }] })
    const path = picked?.[0]
    if (!path) {
      setError(NO_PICK)
      return
    }
    accept(new TextDecoder().decode(await api.fs.read(path)), path.split(/[\\/]/).pop() ?? path)
  }

  async function readDropped(file: File): Promise<void> {
    const text = await file.text()
    if (!text.trim()) {
      setError(DROP_UNREADABLE)
      return
    }
    accept(text, file.name)
  }

  function pngEdge(): number | null {
    const n = Math.round(Number(pngSize))
    return Number.isFinite(n) && n >= PNG_MIN && n <= PNG_MAX ? n : null
  }

  /** 出图 → 问落点 → 写盘。落点是 saveFile 给的，那条路径同时拿到写授权 */
  async function emit(kind: 'png' | 'ico'): Promise<void> {
    if (!usable) {
      setError(svg.trim() ? NOT_SVG : NO_SOURCE)
      return
    }
    const edge = pngEdge()
    if (edge === null) {
      setError(RANGE_MESSAGE)
      return
    }
    setBusy(true)
    setError('')
    try {
      const bytes =
        kind === 'png'
          ? (await svgToFrames(svg, [edge]))[0]!.png
          : buildIco(await svgToFrames(svg, [...ICON_FRAME_SIZES]))
      const target = await api.dialog.saveFile({
        title: kind === 'png' ? 'icon.png 存到哪里' : 'icon.ico 存到哪里',
        defaultPath: kind === 'png' ? 'icon.png' : 'icon.ico',
        filters: [{ name: kind === 'png' ? 'PNG' : 'ICO', extensions: [kind] }]
      })
      if (!target) {
        setError(NO_TARGET)
        return
      }
      await api.fs.write(target, bytes)
      const kb = (bytes.length / 1024).toFixed(1)
      setNote(
        kind === 'png'
          ? `icon.png 已写到 ${target}（${edge} × ${edge}，${kb} KB）。`
          : `icon.ico 已写到 ${target}（${frameSizesPhrase(describeIco(bytes))}，每帧 32 位 PNG，${kb} KB）。`
      )
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="airship-icon">
      <h2>Icon Helper</h2>
      <p className="hint">
        给一份 SVG，出这两张：`icon.png`（标题栏左上角那枚 15 × 15 记号的源图）与 `icon.ico`（外壳那 7 帧）。
        标准与尺寸见 docs/apps/icons.md；现在亮的是{resolved === 'dark' ? '暗色' : '亮色'}那一档。
      </p>

      <div className="row">
        <button type="button" onClick={() => void pickFile()}>
          选 SVG 文件
        </button>
        <span className="src">来源：{source || '还没有'}</span>
      </div>

      <textarea
        className="svg-src"
        aria-label="SVG 源码"
        value={svg}
        rows={8}
        spellCheck={false}
        placeholder="<svg …> 贴在这里，或从上面那颗键选文件"
        onChange={(e) => accept(e.target.value, '粘贴')}
        onDrop={(e) => {
          e.preventDefault()
          const file = e.dataTransfer.files[0]
          if (file) void readDropped(file)
        }}
        onDragOver={(e) => e.preventDefault()}
      />

      <p className="note">{note}</p>
      <p className="error" aria-live="polite">
        {error}
      </p>

      <div className="preview" aria-label="预览">
        {box &&
          PREVIEW_SIZES.map((size) => (
            <span className="preview-cell" key={size}>
              <img src={previewUrl} width={size} height={size} alt={`预览 ${size} 像素`} />
              <em>{size}px</em>
            </span>
          ))}
        {!box && <span className="preview-empty">还没有可预览的东西</span>}
      </div>

      <div className="row out">
        <label className="edge">
          <span>PNG 边长</span>
          <input
            type="number"
            aria-label="PNG 边长"
            min={PNG_MIN}
            max={PNG_MAX}
            step={1}
            value={pngSize}
            onChange={(e) => setPngSize(e.target.value)}
          />
          <em>px（{PNG_MIN} – {PNG_MAX}）</em>
        </label>
        <button type="button" disabled={!usable || busy} onClick={() => void emit('png')}>
          出 icon.png
        </button>
        <button type="button" disabled={!usable || busy} onClick={() => void emit('ico')}>
          出 icon.ico（{ICON_FRAME_SIZES.length} 帧）
        </button>
      </div>
      {busy && <p className="note">正在画…</p>}
    </div>
  )
}
