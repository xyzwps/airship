import { useEffect, useRef, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import { AlbedoWorkspace } from './albedoWorkspace.ts'
import './albedo.css'

/**
 * Albedo 的 React 外壳：只负责画静态骨架（与单文件版的 body 一一对应），
 * 真正的编辑器住在 `albedoWorkspace.ts`——那是舞台、手势、检查器与文档状态的地方。
 *
 * 三处与网页原版的有意差异，都在册子里各钉了一条：
 *   1. 字体模态整族删除（浏览器枚举本机字体在包里走不通）：文字层点「选择字体」
 *      直接开系统文件框挑 .ttf/.otf/.ttc，选中的字体复制进应用数据目录供导出复用；
 *   2. 隐藏的 <input type=file> 换成系统对话框（导入 SVG 与桌布图片同一条路），
 *      拖放导入不受影响；
 *   3. 自动保存从 localStorage 换到 api.settings（能力 settings），导出/复制走
 *      dialog + fs.write + clipboard。
 */
export default function AlbedoApp({ api }: { api: AppApi }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  useTheme()

  useEffect(() => {
    const host = rootRef.current
    if (!host) return
    const ws = new AlbedoWorkspace(host, api)
    void ws.boot()
    return () => ws.dispose()
  }, [api])

  return (
    <div className="app" ref={rootRef}>
      <header className="topbar">
        <div className="brand" aria-label="Albedo SVG Studio">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 160 160" xmlns="http://www.w3.org/2000/svg" focusable="false">
              <rect x="0" y="0" width="160" height="160" rx="20" fill="#f2c75c" stroke="none" />
              <rect x="20" y="40" width="80" height="60" rx="10" fill="#f26b4f" stroke="#405533" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" />
              <ellipse cx="100" cy="100" rx="40" ry="30" fill="#98a6e8" stroke="none" />
            </svg>
          </span>
          <span>
            <span className="brand-name">Albedo</span>
            <span className="brand-sub">SVG STUDIO / 01</span>
          </span>
        </div>

        <div className="doc-block">
          <input id="docTitle" className="doc-title" defaultValue="Untitled Canvas" data-i18n-aria="doc.nameAria" maxLength={60} />
          <span id="saveState" className="save-state" data-i18n="save.saved">已保存</span>
        </div>

        <div className="top-actions">
          <select id="langSelect" className="lang-select" data-i18n-aria="lang.label" aria-label="Language" defaultValue="auto">
            <option value="auto" data-i18n="lang.auto">自动</option>
            <option value="zh" data-i18n="lang.zh">简体中文</option>
            <option value="en" data-i18n="lang.en">English</option>
          </select>
          <button id="undoBtn" className="tb-btn icon-only" data-i18n-title="action.undoTitle" data-i18n-aria="action.undo" title="Undo (Ctrl+Z)" aria-label="Undo">↺</button>
          <button id="redoBtn" className="tb-btn icon-only" data-i18n-title="action.redoTitle" data-i18n-aria="action.redo" title="Redo (⇧Ctrl+Z)" aria-label="Redo">↻</button>
          <span className="sep"></span>
          <button id="newBtn" className="tb-btn" data-i18n-title="action.newTitle" title="New blank canvas" data-i18n="action.new">新建</button>
          <button id="importSvgBtn" className="tb-btn" data-i18n-title="action.importSvgTitle" title="Import SVG file" data-i18n="action.importSvg">导入 SVG</button>
          <button id="copyBtn" className="tb-btn" data-i18n-title="action.copySvgTitle" title="Copy SVG code" data-i18n="action.copySvg">复制 SVG</button>
          <button id="exportBtn" className="tb-btn primary" data-i18n-title="action.exportSvgTitle" title="Export SVG file">
            <span data-i18n="action.exportSvg">导出 SVG</span> <span aria-hidden="true">↗</span>
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="left-panel">
          <nav className="panel-rail left-rail" id="leftRail" role="tablist" aria-orientation="vertical" aria-label="Panel tabs" data-i18n-aria="nav.railLabel">
            <button type="button" className="rail-btn" id="leftTabInsert" role="tab" aria-controls="leftPanelInsert" aria-selected="true" tabIndex={0} data-rail-go="insert" title="Insert shape" data-i18n-title="nav.insert" aria-label="Insert shape" data-i18n-aria="nav.insert">
              <svg className="rail-icon" viewBox="0 0 128 128" width="128" height="128" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M64 28v72M28 64h72" /></svg>
            </button>
            <button type="button" className="rail-btn" id="leftTabLayers" role="tab" aria-controls="leftPanelLayers" aria-selected="false" tabIndex={-1} data-rail-go="layers" title="Layers" data-i18n-title="nav.layers" aria-label="Layers" data-i18n-aria="nav.layers">
              <svg className="rail-icon" viewBox="0 0 128 128" width="128" height="128" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M64 20 16 44l48 24 48-24-48-24Z" /><path d="M16 64l48 24 48-24" /><path d="M16 84l48 24 48-24" /></svg>
            </button>
          </nav>
          <div className="panel-main" id="leftPanelBody">
            <section className="panel-section" id="leftPanelInsert" role="tabpanel" aria-labelledby="leftTabInsert" data-rail-section="insert">
              <h2 className="section-title"><span className="section-label" data-i18n="insert.title">添加图形</span> <span>INSERT</span></h2>
              <div className="shape-grid">
                <button className="shape-btn" data-add="rect" title="Add rectangle (R)">
                  <span className="shape-preview preview-rect"></span>
                  <span className="shape-meta"><span data-i18n="shape.rect">矩形</span><kbd>R</kbd></span>
                </button>
                <button className="shape-btn" data-add="ellipse" title="Add ellipse (O)">
                  <span className="shape-preview preview-ellipse"></span>
                  <span className="shape-meta"><span data-i18n="shape.ellipse">椭圆</span><kbd>O</kbd></span>
                </button>
                <button className="shape-btn" data-add="circle" title="Add circle (C)">
                  <svg className="shape-preview" viewBox="0 0 30 26" aria-hidden="true">
                    <circle cx="15" cy="13" r="10.5" fill="none" stroke="#2c3138" strokeWidth="1.7"></circle>
                  </svg>
                  <span className="shape-meta"><span data-i18n="shape.circle">圆形</span><kbd>C</kbd></span>
                </button>
                <button className="shape-btn" data-add="polygon" title="Add polygon (G)">
                  <svg className="shape-preview" viewBox="0 0 30 26" aria-hidden="true">
                    <polygon points="15,2.5 27,10.5 22.5,24 7.5,24 3,10.5" fill="none" stroke="#2c3138" strokeWidth="1.7" strokeLinejoin="round"></polygon>
                  </svg>
                  <span className="shape-meta"><span data-i18n="shape.polygon">多边形</span><kbd>G</kbd></span>
                </button>
                <button className="shape-btn" data-add="line" title="Add line (L)">
                  <span className="shape-preview preview-line"></span>
                  <span className="shape-meta"><span data-i18n="shape.line">直线</span><kbd>L</kbd></span>
                </button>
                <button className="shape-btn" data-add="text" title="Add text (T)">
                  <span className="shape-preview preview-text">A</span>
                  <span className="shape-meta"><span data-i18n="shape.text">文字</span><kbd>T</kbd></span>
                </button>
                <button className="shape-btn" data-add="path" title="Add path (P)">
                  <span className="shape-preview preview-path"></span>
                  <span className="shape-meta"><span data-i18n="shape.path">路径</span><kbd>P</kbd></span>
                </button>
              </div>
              <button type="button" id="insertSvgBtn" className="import-svg" data-i18n-title="insert.importSvgTitle" title="Import an SVG file as editable shapes">
                <span className="import-svg-icon" aria-hidden="true">
                  <svg viewBox="0 0 128 128" width="128" height="128" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M64 86V24" /><path d="M40 46l24-24 24 24" /><path d="M24 78v22c0 7 5 12 12 12h56c7 0 12-5 12-12V78" /></svg>
                </span>
                <span className="import-svg-copy">
                  <b data-i18n="insert.importSvg">导入 SVG</b>
                  <em data-i18n="insert.importSvgHint">矢量图形 · 可继续编辑</em>
                </span>
              </button>
              <p className="tool-note" data-i18n="insert.note">选择一个图形后，在右侧调整参数。路径按命令栈编辑，多边形可改边数和顶点坐标。</p>
            </section>

            <section className="panel-section grow" id="leftPanelLayers" role="tabpanel" aria-labelledby="leftTabLayers" data-rail-section="layers" hidden>
              <h2 className="section-title"><span className="section-label" data-i18n="layers.title">图层</span> <span id="layerCount">0</span></h2>
              <div id="layers" className="layer-list" data-i18n-aria="layers.aria" aria-label="Layer list"></div>
            </section>
          </div>
        </aside>

        <main className="stage">
          <div className="stage-head">
            <div className="stage-guides" role="toolbar" aria-label="Guides" data-i18n-aria="assist.title">
              <div className="guide-cluster">
                <button type="button" id="gridToggle" className="guide-btn" aria-pressed="false" data-i18n-title="assist.gridTitle" title="Show grid">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M2.5 2.5h11v11h-11zM6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" /></svg>
                  <span data-i18n="assist.grid">网格</span>
                </button>
                <select id="gridSize" className="guide-select" data-i18n-aria="assist.gridSize" aria-label="Grid size" title="Grid size" defaultValue="8">
                  {([1, 2, 4, 8, 16, 32] as const).map((n) => (
                    <option key={n} value={String(n)}>{n} px</option>
                  ))}
                </select>
              </div>
              <button type="button" id="snapToggle" className="guide-btn is-active" aria-pressed="true" data-i18n-title="assist.snapTitle" title="Snap">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></svg>
                <span data-i18n="assist.snap">吸附</span>
              </button>
              <div className="guide-reference">
                <button type="button" id="underlayToggle" className="guide-btn guide-reference-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="underlayPopover" data-i18n-title="underlay.importTitle" title="Reference">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.3" /><path d="m3 12 3.6-3.4 2.4 2.2 1.7-1.6L14 12" /></svg>
                  <span data-i18n="underlay.title">桌布</span>
                  <span className="guide-state-dot" id="underlayStateDot" aria-hidden="true"></span>
                </button>
                <div className="underlay-popover" id="underlayPopover" role="dialog" aria-label="Reference" data-i18n-aria="underlay.title" hidden>
                  <div className="underlay-popover-head">
                    <b data-i18n="underlay.title">桌布</b>
                    <button type="button" id="underlayPopoverClose" className="underlay-popover-close" data-i18n-title="action.close" data-i18n-aria="action.close" title="Close" aria-label="Close">✕</button>
                  </div>
                  <div id="underlayEmpty" className="underlay-empty">
                    <button type="button" id="underlayImportBtn" className="underlay-import" data-i18n-title="underlay.importTitle" title="Import an image as a tracing reference">
                      <span className="underlay-plus">＋</span>
                      <span>
                        <b data-i18n="underlay.import">导入桌布</b>
                        <em data-i18n="underlay.importHint">点击选择，或拖入画布</em>
                      </span>
                    </button>
                  </div>
                  <div id="underlayControls" className="underlay-controls" hidden>
                    <div className="underlay-file">
                      <img id="underlayThumb" className="underlay-thumb" alt="" />
                      <div className="underlay-file-meta">
                        <b id="underlayName">桌布图片</b>
                        <span id="underlayMeta">0 × 0</span>
                      </div>
                      <button type="button" id="underlayRemoveBtn" className="underlay-remove" data-i18n-title="underlay.remove" data-i18n-aria="underlay.remove" title="Remove reference" aria-label="Remove reference">✕</button>
                    </div>
                    <div className="underlay-row">
                      <button type="button" id="underlayVisibleBtn" className="underlay-btn" data-i18n="underlay.visible">可见</button>
                      <button type="button" id="underlayAdjustBtn" className="underlay-btn" data-i18n="underlay.adjust">调整位置</button>
                      <button type="button" id="underlayReplaceBtn" className="underlay-btn" data-i18n="underlay.replace">替换</button>
                    </div>
                    <p id="underlayHint" className="underlay-hint" hidden data-i18n="underlay.hint">拖动移动；拖动四角等比例缩放。</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="stage-meta">
              <div className="zoom-controls">
                <button type="button" id="zoomOutBtn" className="zoom-btn" data-i18n-title="canvas.zoomOut" title="Zoom out">&minus;</button>
                <button type="button" id="zoomFitBtn" className="zoom-btn zoom-label-btn" data-i18n-title="canvas.zoomReset" title="Reset zoom to 100%"><span id="zoomLabel">100%</span></button>
                <button type="button" id="zoomInBtn" className="zoom-btn" data-i18n-title="canvas.zoomIn" title="Zoom in">+</button>
              </div>
              <button type="button" id="canvasSizeBtn" className="meta-pill canvas-size-btn" data-i18n-title="canvas.changeSize" title="Change canvas size" aria-haspopup="dialog" aria-controls="canvasModal">
                <span id="canvasSizeLabel">960 × 640</span>
                <span className="edit-glyph" aria-hidden="true" data-i18n="action.edit">编辑</span>
              </button>
              <span className="meta-pill svg-version">SVG 1.1</span>
            </div>
          </div>

          <div className="stage-body" id="stageBody">
            <div className="artboard-wrap" id="artboardWrap">
              <div className="artboard">
                <svg id="stage" viewBox="0 0 960 640" xmlns="http://www.w3.org/2000/svg" role="application" aria-label="SVG canvas">
                  <defs id="stageDefs"></defs>
                  <rect id="canvasBg" x="0" y="0" width="960" height="640" fill="#fffdf8"></rect>
                  <g id="underlayLayer" pointerEvents="none" aria-hidden="true"></g>
                  <g id="gridLayer" pointerEvents="none" aria-hidden="true"></g>
                  <g id="shapeLayer"></g>
                  <g id="overlay" pointerEvents="none"></g>
                </svg>
                <div id="emptyCanvas" className="empty-canvas" aria-hidden="true">
                  <span className="empty-canvas-plus">＋</span>
                  <strong data-i18n="canvas.emptyTitle">从这里开始</strong>
                  <p data-i18n="canvas.emptyHint">从左侧选择图形，或按 R / O / L / P / T 快速添加</p>
                </div>
              </div>
              <span className="artboard-corner corner-tl"></span>
              <span className="artboard-corner corner-tr"></span>
              <span className="artboard-corner corner-bl"></span>
              <span className="artboard-corner corner-br"></span>
              <div id="canvasTip" className="canvas-tip"><span className="tip-dot"></span><span data-i18n="canvas.tip">拖动橙色手柄改变曲线</span></div>
            </div>
            <div id="stageDrop" className="stage-drop" aria-hidden="true">
              <span>＋</span>
              <b data-i18n="canvas.drop">松开导入</b>
              <em>SVG · PNG · JPG · WEBP</em>
            </div>
          </div>

          <div className="stage-foot">
            <span id="coordStatus" className="coord-readout">X 000{'\u00A0\u00A0'}Y 000</span>
            <span className="status-sep"></span>
            <span id="shapeStatus">0 个图形</span>
            <span className="spacer"></span>
            <span id="nodeStatus" data-i18n="status.noSelection">未选择对象</span>
            <span className="status-sep"></span>
            <span className="foot-badge">LOCAL AUTOSAVE</span>
          </div>
        </main>

        <aside className="right-panel">
          <div id="inspector" className="inspector-scroll" aria-live="polite"></div>
          <nav className="panel-rail right-rail" id="inspectorRail" role="tablist" aria-orientation="vertical" aria-label="Inspector tabs" data-i18n-aria="nav.inspectorRailLabel"></nav>
        </aside>
      </div>

      <div id="canvasModal" className="modal-root" hidden>
        <div className="modal-backdrop" data-close-canvas></div>
        <section className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="canvasModalTitle">
          <header className="modal-head">
            <div>
              <div className="modal-eyebrow">ARTBOARD · CANVAS</div>
              <h2 id="canvasModalTitle" data-i18n="modal.title">画布尺寸</h2>
            </div>
            <button type="button" className="modal-close" data-close-canvas data-i18n-aria="action.close" aria-label="Close">✕</button>
          </header>
          <p className="modal-desc" data-i18n="modal.desc">设置 SVG 画布的逻辑尺寸。已有图形保持原位；缩小画布会裁切超出边界的部分。</p>
          <div className="size-row">
            <label className="size-field">
              <span data-i18n="modal.width">宽度</span>
              <span className="size-input"><input id="canvasWidthInput" type="number" min="64" max="10000" step="1" inputMode="numeric" data-i18n-aria="modal.widthAria" aria-label="Canvas width" /><em>px</em></span>
            </label>
            <span className="size-times">×</span>
            <label className="size-field">
              <span data-i18n="modal.height">高度</span>
              <span className="size-input"><input id="canvasHeightInput" type="number" min="64" max="10000" step="1" inputMode="numeric" data-i18n-aria="modal.heightAria" aria-label="Canvas height" /><em>px</em></span>
            </label>
            <span id="canvasRatioChip" className="ratio-chip">3 : 2</span>
          </div>
          <div className="preset-head" data-i18n="modal.commonSizes">常用尺寸</div>
          <div className="size-presets">
            <button type="button" className="size-preset" data-preset="960,640"><b>960 × 640</b><span data-i18n="modal.presetClassic">经典 · 3:2</span></button>
            <button type="button" className="size-preset" data-preset="1080,1080"><b>1080 × 1080</b><span data-i18n="modal.presetSquare">方形 · 1:1</span></button>
            <button type="button" className="size-preset" data-preset="1200,630"><b>1200 × 630</b><span data-i18n="modal.presetBanner">横幅 · 1.9:1</span></button>
            <button type="button" className="size-preset" data-preset="1920,1080"><b>1920 × 1080</b><span data-i18n="modal.presetWidescreen">宽屏 · 16:9</span></button>
          </div>
          <p id="canvasSizeError" className="modal-error" aria-live="polite"></p>
          <footer className="modal-foot">
            <button type="button" className="modal-btn" data-close-canvas data-i18n="action.cancel">取消</button>
            <button type="button" id="canvasApplyBtn" className="modal-btn primary" data-i18n="action.applySize">应用尺寸</button>
          </footer>
        </section>
      </div>

      <div id="toast" role="status"></div>
    </div>
  )
}
