import { type JSX, type ReactNode } from 'react'
import { formatSize, formatTime, type ObjectRow } from './client.ts'

/**
 * 右边这一栏：面包屑 + 当前这一层的对象表。
 *
 * 行里只留认得出这个对象的东西（名字、大小、时间），三个动作挂在行尾的图标键上——
 * 文字按钮会把列撑满，一列几十行各挂三颗键，表就只剩键了。
 * 图标键必须带悬停说明与无障碍名称，这是这个仓库的硬规矩。
 *
 * 单击一行 = 选中它（右侧出详情与预览）；目录行单击是进去。
 */
export function ObjectsView({
  bucket,
  prefix,
  trail,
  rows,
  hasMore,
  busy,
  selectedKey,
  onEnterPrefix,
  onCrumb,
  onUp,
  onMore,
  onSelect,
  onDownload,
  onCopyLink,
  onDelete
}: {
  bucket: string
  prefix: string
  trail: string[]
  rows: ObjectRow[]
  hasMore: boolean
  busy: boolean
  selectedKey: string | null
  onEnterPrefix: (key: string) => void
  onCrumb: (index: number) => void
  onUp: () => void
  onMore: () => void
  onSelect: (row: ObjectRow) => void
  onDownload: (row: ObjectRow) => void
  onCopyLink: (row: ObjectRow) => void
  onDelete: (row: ObjectRow) => void
}): JSX.Element {
  return (
    <section className="s3__objects">
      <div className="s3__crumbs">
        <button type="button" className="s3__crumb" data-test="crumb:-1" onClick={() => onCrumb(-1)}>
          {bucket}
        </button>
        {trail.map((seg, i) => (
          <span key={`${seg}-${i}`} className="s3__crumb-wrap">
            <span className="s3__crumb-sep">/</span>
            <button
              type="button"
              className={`s3__crumb${i === trail.length - 1 ? ' s3__crumb--here' : ''}`}
              data-test={`crumb:${i}`}
              onClick={() => onCrumb(i)}
            >
              {seg}
            </button>
          </span>
        ))}
        {trail.length > 0 ? (
          <button type="button" className="btn btn--ghost s3__up" data-test="up" onClick={onUp}>
            上一级
          </button>
        ) : null}
        {hasMore ? (
          <button type="button" className="btn btn--ghost s3__more" data-test="more" onClick={onMore} disabled={busy}>
            还有更多
          </button>
        ) : null}
      </div>

      {rows.length === 0 && !busy ? <p className="s3__empty">这一格里没有东西</p> : null}

      <table className="s3__table">
        <thead>
          <tr>
            <th>名字</th>
            <th>大小</th>
            <th>改动时间</th>
            <th className="s3__acts-h">动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              className={r.kind === 'object' && r.key === selectedKey ? 's3__row--on' : ''}
              onClick={() => (r.kind === 'prefix' ? onEnterPrefix(r.key) : onSelect(r))}
            >
              <td>
                {r.kind === 'prefix' ? (
                  <span className="s3__folder" data-test={`dir:${r.key}`}>
                    {r.label}
                  </span>
                ) : (
                  <span className="s3__name" data-test={`row:${r.key}`}>
                    {r.label}
                  </span>
                )}
              </td>
              <td className="s3__num">{r.kind === 'prefix' ? '' : formatSize(r.size)}</td>
              <td className="s3__time">{formatTime(r.lastModified)}</td>
              <td className="s3__acts">
                {r.kind === 'object' ? (
                  <>
                    <RowIcon label="下载" test={`dl:${r.key}`} onClick={() => onDownload(r)}>
                      <path d="M8 2.4v7.2M5 7l3 3 3-3" /><path d="M2.8 12.6h10.4" />
                    </RowIcon>
                    <RowIcon label="复制临时链接" test={`link:${r.key}`} onClick={() => onCopyLink(r)}>
                      <path d="M6.6 9.4 9.4 6.6" /><path d="M7.2 4.2l1-1a2.4 2.4 0 0 1 3.4 3.4l-1 1" /><path d="M8.8 11.8l-1 1a2.4 2.4 0 0 1-3.4-3.4l1-1" />
                    </RowIcon>
                    <RowIcon label="删掉" test={`del:${r.key}`} onClick={() => onDelete(r)}>
                      <path d="M2.8 4.3h10.4M6.4 4.3V2.8h3.2v1.5" /><path d="M4.2 4.3l.7 8.4h6.2l.7-8.4" />
                    </RowIcon>
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="s3__hint">
        {prefix === '' ? `${bucket} 的根` : `${bucket} / ${prefix}`}
      </p>
    </section>
  )
}

/** 行尾那颗图标键：只画图形，名字靠 title 与 aria-label 说话，`test` 是用例点得动它的那枚句柄 */
function RowIcon({ label, test, onClick, children }: { label: string; test: string; onClick: () => void; children: ReactNode }): JSX.Element {
  return (
    <button
      type="button"
      className="icon-btn s3__icon"
      data-test={test}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}
