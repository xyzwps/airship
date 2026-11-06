import { type JSX } from 'react'
import type { DemoName } from './help'

/**
 * 说明卡里那几段小动画：纯 CSS，不引库、不画位图，动的是"位置与长短"这一个意思。
 *
 * 只给靠文字说不清的那几处（体积与质量的此消彼长、索引从尾搬到头），
 * 其余参数一句话读完就够，加动画反而是噪声。动画一律 aria-hidden：
 * 读屏拿到的还是上面那两句文字。
 */
export function HelpDemo({ name }: { name: DemoName }): JSX.Element {
  if (name === 'faststart') {
    return (
      <div className="vcp__demo" aria-hidden="true">
        <div className="vcp__demo-file">
          <span className="vcp__demo-mdat">mdat · 正片数据</span>
          <span className="vcp__demo-moov">moov</span>
        </div>
        <div className="vcp__demo-line">
          <span className="vcp__demo-play">{'▶'}</span>
          <span className="vcp__demo-cap">索引落到头上，一边下载就能一边播</span>
        </div>
      </div>
    )
  }

  if (name === 'pixfmt') {
    return (
      <div className="vcp__demo" aria-hidden="true">
        <div className="vcp__demo-chroma vcp__demo-chroma--full">4:4:4</div>
        <div className="vcp__demo-chroma vcp__demo-chroma--half">4:2:0</div>
        <div className="vcp__demo-cap">同一层色度摊开一倍：亮度一格没少，色度每两格留一格</div>
      </div>
    )
  }

  // crf：旋钮往"细"那一头走，体积就长；往"省"那一头走，体积就缩
  return (
    <div className="vcp__demo" aria-hidden="true">
      <div className="vcp__demo-line">
        <span className="vcp__demo-cap">细</span>
        <span className="vcp__demo-track">
          <span className="vcp__demo-knob" />
        </span>
        <span className="vcp__demo-cap">省</span>
      </div>
      <div className="vcp__demo-bar">
        <span className="vcp__demo-fill" />
      </div>
      <div className="vcp__demo-cap">体积跟着反着走</div>
    </div>
  )
}
