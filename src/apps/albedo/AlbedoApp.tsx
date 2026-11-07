import { useEffect, useRef, type JSX } from 'react'
import type { AppApi } from '@airship/contract'
import { AlbedoWorkspace } from './albedoWorkspace.ts'
import './albedo.css'

/**
 * Albedo 的 React 外壳：只负责画静态骨架（Photoshop 式布局），
 * 真正的编辑器住在 `albedoWorkspace.ts`——舞台、手势、检查器与文档状态都在那里。
 *
 * 布局五块：顶部选项条（保存态/撤销重做/文件动作/语言）、左侧竖排图标工具条、
 * 中间画布区（辅助条 + 深灰画布面 + 底部状态条）、右侧停靠面板（上属性、下图层）。
 * 外壳固定深色——深灰金属就是这套工具的样子，不跟壳的主题键走（画布纸色不受影响）。
 *
 * 三处与网页原版的有意差异（各自在册子里钉着）：
 *   1. 字体模态整族删除：文字层点「选择字体」直接开系统文件框挑 .ttf/.otf/.ttc；
 *   2. 隐藏的 <input type=file> 换成系统对话框，拖放导入不受影响；
 *   3. 自动保存走 api.settings，导出/复制走 dialog + fs.write + clipboard。
 */
export default function AlbedoApp({ api }: { api: AppApi }): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)

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
        <span id="saveState" className="save-state" data-i18n="save.saved">已保存</span>

        <span className="tb-sep" aria-hidden="true"></span>

        <div className="top-actions">
          <button id="undoBtn" className="tb-btn icon-only" data-i18n-title="action.undoTitle" data-i18n-aria="action.undo" title="撤销 (Ctrl+Z)" aria-label="Undo">↶</button>
          <button id="redoBtn" className="tb-btn icon-only" data-i18n-title="action.redoTitle" data-i18n-aria="action.redo" title="重做 (Ctrl+⇧Z)" aria-label="Redo">↷</button>
          <span className="tb-sep" aria-hidden="true"></span>
          <button id="newBtn" className="tb-btn" data-i18n-title="action.newTitle" title="新建空白画布" data-i18n="action.new">新建</button>
          <button id="importSvgBtn" className="tb-btn" data-i18n-title="action.importSvgTitle" title="导入 SVG 文件" data-i18n="action.importSvg">导入 SVG</button>
          <button id="copyBtn" className="tb-btn" data-i18n-title="action.copySvgTitle" title="复制 SVG 代码" data-i18n="action.copySvg">复制 SVG</button>
          <button id="exportBtn" className="tb-btn primary" data-i18n-title="action.exportSvgTitle" title="导出 SVG 文件">
            <span data-i18n="action.exportSvg">导出 SVG</span>
          </button>
          <button id="exportPngBtn" className="tb-btn" data-i18n-title="action.exportPngTitle" title="导出 PNG 位图（与画布同尺寸）" data-i18n="action.exportPng">导出 PNG</button>
        </div>

        <span className="tb-spacer"></span>

        <select id="langSelect" className="lang-select" data-i18n-aria="lang.label" aria-label="语言" defaultValue="auto">
          <option value="auto" data-i18n="lang.auto">自动</option>
          <option value="zh" data-i18n="lang.zh">简体中文</option>
          <option value="en" data-i18n="lang.en">English</option>
        </select>
      </header>

      <div className="workspace">
        <nav className="tool-rail" role="toolbar" aria-orientation="vertical" aria-label="工具" data-i18n-aria="nav.toolsRail">
          <button className="shape-btn tool-btn-v" data-add="rect" title="添加矩形 (R)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="ellipse" title="添加椭圆 (O)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="10" rx="7.2" ry="5.2" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="circle" title="添加圆形 (C)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="polygon" title="添加多边形 (G)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><polygon points="10,2.6 17.4,8 14.6,16.8 5.4,16.8 2.6,8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="line" title="添加直线 (L)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 16.5 16.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="text" title="添加文字 (T)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5h12M10 5v11M7 16h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button className="shape-btn tool-btn-v" data-add="path" title="添加路径 (P)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 15c4 0 3-10 7.5-10s3.5 10 7.5 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><rect x="1.6" y="14.1" width="2.4" height="2.4" fill="currentColor" stroke="none" /><rect x="16" y="14.1" width="2.4" height="2.4" fill="currentColor" stroke="none" /></svg>
          </button>
          <span className="rail-sep" aria-hidden="true"></span>
          <button type="button" id="insertSvgBtn" className="tool-btn-v" data-i18n-title="insert.importSvgTitle" title="导入 SVG 文件到画布" data-i18n-aria="insert.importSvg" aria-label="导入 SVG">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3.5M6 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /><path d="M3.5 12v4a1.6 1.6 0 0 0 1.6 1.6h9.8a1.6 1.6 0 0 0 1.6-1.6v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </nav>

        <main className="stage">
          <div className="stage-head">
            <div className="stage-guides" role="toolbar" aria-label="辅助" data-i18n-aria="assist.title">
              <div className="guide-cluster">
                <button type="button" id="gridToggle" className="guide-btn" aria-pressed="false" data-i18n-title="assist.gridTitle" title="显示或隐藏网格">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M2.5 2.5h11v11h-11zM6.2 2.5v11M9.8 2.5v11M2.5 6.2h11M2.5 9.8h11" /></svg>
                  <span data-i18n="assist.grid">网格</span>
                </button>
                <select id="gridSize" className="guide-select" data-i18n-aria="assist.gridSize" aria-label="网格大小" title="网格大小" defaultValue="8">
                  {([1, 2, 4, 8, 16, 32] as const).map((n) => (
                    <option key={n} value={String(n)}>{n} px</option>
                  ))}
                </select>
              </div>
              <button type="button" id="snapToggle" className="guide-btn is-active" aria-pressed="true" data-i18n-title="assist.snapTitle" title="吸附">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></svg>
                <span data-i18n="assist.snap">吸附</span>
              </button>
              <div className="guide-reference">
                <button type="button" id="underlayToggle" className="guide-btn guide-reference-btn" aria-haspopup="dialog" aria-expanded="false" aria-controls="underlayPopover" data-i18n-title="underlay.importTitle" title="导入一张图片作为描图底图">
                  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><rect x="2" y="3" width="12" height="10" rx="1.5" /><circle cx="6" cy="7" r="1.3" /><path d="m3 12 3.6-3.4 2.4 2.2 1.7-1.6L14 12" /></svg>
                  <span data-i18n="underlay.title">桌布</span>
                  <span className="guide-state-dot" id="underlayStateDot" aria-hidden="true"></span>
                </button>
                <div className="underlay-popover" id="underlayPopover" role="dialog" aria-label="桌布" data-i18n-aria="underlay.title" hidden>
                  <div className="underlay-popover-head">
                    <b data-i18n="underlay.title">桌布</b>
                    <button type="button" id="underlayPopoverClose" className="underlay-popover-close" data-i18n-title="action.close" data-i18n-aria="action.close" title="关闭" aria-label="关闭">✕</button>
                  </div>
                  <div id="underlayEmpty" className="underlay-empty">
                    <button type="button" id="underlayImportBtn" className="underlay-import" data-i18n-title="underlay.importTitle" title="导入一张图片作为描图底图">
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
                      <button type="button" id="underlayRemoveBtn" className="underlay-remove" data-i18n-title="underlay.remove" data-i18n-aria="underlay.remove" title="移除桌布" aria-label="移除桌布">✕</button>
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
                <button type="button" id="zoomOutBtn" className="zoom-btn" data-i18n-title="canvas.zoomOut" title="缩小画布（Ctrl + -）">&minus;</button>
                <button type="button" id="zoomFitBtn" className="zoom-btn zoom-label-btn" data-i18n-title="canvas.zoomReset" title="恢复 100% 缩放（Ctrl + 0）"><span id="zoomLabel">100%</span></button>
                <button type="button" id="zoomInBtn" className="zoom-btn" data-i18n-title="canvas.zoomIn" title="放大画布（Ctrl + =）">+</button>
                <button type="button" id="zoomFitScreenBtn" className="zoom-btn zoom-icon-btn" data-i18n-title="canvas.zoomFitScreen" data-i18n-aria="canvas.zoomFitScreenAria" title="适应屏幕（Ctrl + 1）" aria-label="适应屏幕">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
                </button>
              </div>
              <button type="button" id="canvasSizeBtn" className="meta-pill canvas-size-btn" data-i18n-title="canvas.changeSize" title="修改画布尺寸" aria-haspopup="dialog" aria-controls="canvasModal">
                <span id="canvasSizeLabel">960 × 640</span>
                <span className="edit-glyph" aria-hidden="true" data-i18n="action.edit">编辑</span>
              </button>
            </div>
          </div>

          <div className="stage-body" id="stageBody">
            <div className="artboard-wrap" id="artboardWrap">
              <div className="artboard">
                <svg id="stage" viewBox="0 0 960 640" xmlns="http://www.w3.org/2000/svg" role="application" aria-label="SVG 画布">
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

        <aside className="dock">
          <div className="dock-inspector">
            <div id="inspector" className="inspector-scroll" aria-live="polite"></div>
            <nav className="panel-rail right-rail" id="inspectorRail" role="tablist" aria-orientation="vertical" aria-label="检查器标签" data-i18n-aria="nav.inspectorRailLabel"></nav>
          </div>
          <section className="dock-layers">
            <h2 className="section-title"><span className="section-label" data-i18n="layers.title">图层</span> <span id="layerCount">0</span></h2>
            <div id="layers" className="layer-list" data-i18n-aria="layers.aria" aria-label="图层列表"></div>
          </section>
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
            <button type="button" className="modal-close" data-close-canvas data-i18n-aria="action.close" aria-label="关闭">✕</button>
          </header>
          <p className="modal-desc" data-i18n="modal.desc">设置 SVG 画布的逻辑尺寸。已有图形保持原位；缩小画布会裁切超出边界的部分。</p>
          <div className="size-row">
            <label className="size-field">
              <span data-i18n="modal.width">宽度</span>
              <span className="size-input"><input id="canvasWidthInput" type="number" min="64" max="10000" step="1" inputMode="numeric" data-i18n-aria="modal.widthAria" aria-label="画布宽度" /><em>px</em></span>
            </label>
            <span className="size-times">×</span>
            <label className="size-field">
              <span data-i18n="modal.height">高度</span>
              <span className="size-input"><input id="canvasHeightInput" type="number" min="64" max="10000" step="1" inputMode="numeric" data-i18n-aria="modal.heightAria" aria-label="画布高度" /><em>px</em></span>
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
