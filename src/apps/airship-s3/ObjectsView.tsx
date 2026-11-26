import { type JSX } from 'react'
import { Icon } from '@iconify/react'
import { formatSize, formatTime } from './display.ts'
import type { ObjectRow } from './backendStore.ts'
import './icons.ts'

/**
 * 右边这一栏：面包屑 + 当前这一层的对象表 + 页脚（路径与翻页）。
 *
 * 行里只留认得出这个对象的东西（名字、大小、时间），动作挂在行尾的图标键上——
 * 文字按钮会把列撑满，一列几十行各挂四颗键，表就只剩键了。
 * 图标键必须带悬停说明与无障碍名称，这是这个仓库的硬规矩。
 *
 * 单击一行 = 选中它（右侧出详情与预览）；目录行单击是进去，它那一列只有一颗删键——
 * 目录与桶在端点上没有改名的接口，重命名这一颗只挂在对象行上（判据见册子 OS-050）。
 *
 * 行号列按段记：每段从 1 数起，目录行也算一行（判据 OS-057）。
 * 翻页在页脚，钉在栏底（只有表在滚）：「上一页」、「本页 M 个」、「下一页」。
 * 一段是端点回多少行就画多少行（照单全收，判据 OS-059~061）——`MaxKeys` 数的是键不是行，
 * 行数没有准，所以页脚念不出"第 N 页"，只念得出这一段摆了多少行。
 * 第一段按不动「上一页」，端点没有往后翻的 token 就按不动「下一页」。
 *
 * `loading` 是迟到 200ms 的转圈（观感，不进册子）：列层在跑且超过 200ms 才盖上，
 * 快网下数据回来得早，一闪都不闪。
 */
export function ObjectsView({
  bucket,
  prefix,
  trail,
  rows,
  pageIndex,
  hasNext,
  busy,
  loading,
  selectedKey,
  creating,
  onEnterPrefix,
  onCrumb,
  onPrev,
  onNext,
  onSelect,
  onDownload,
  onCopyLink,
  onRename,
  onDelete,
  onDeleteDir,
  onUpload,
  onNewDir
}: {
  bucket: string
  prefix: string
  trail: string[]
  rows: ObjectRow[]
  /** 当前是这一层的第几段（0 起）；只用来决定「上一页」按不按得动 */
  pageIndex: number
  hasNext: boolean
  busy: boolean
  /** 转圈盖不盖：上层把"列层在跑"晚 200ms 再交下来，快网下永远是假 */
  loading: boolean
  selectedKey: string | null
  /** 新建那一格 inline 条摊着没有：摊着就不许再点「新建目录」 */
  creating: boolean
  onEnterPrefix: (key: string) => void
  onCrumb: (index: number) => void
  onPrev: () => void
  onNext: () => void
  onSelect: (row: ObjectRow) => void
  onDownload: (row: ObjectRow) => void
  onCopyLink: (row: ObjectRow) => void
  onRename: (row: ObjectRow) => void
  onDelete: (row: ObjectRow) => void
  onDeleteDir: (row: ObjectRow) => void
  onUpload: () => void
  onNewDir: () => void
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
        {/* 没有「上一级」键：面包屑上每一段都点得动，回上一级就是点它前面那一段（2026-11-22 他点名去掉这颗重复入口） */}
        {/* 上传与新建目录管的是"当前这一层"，所以挂在这一层的头上、推到行尾，不在全局顶栏杵着 */}
        <div className="s3__crumb-acts">
          <button type="button" className="icon-btn" data-test="upload" title="上传" aria-label="上传" disabled={busy || creating} onClick={onUpload}>
            <Icon icon="lucide:upload" width="16" height="16" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" data-test="new-dir" title="新建目录" aria-label="新建目录" disabled={creating} onClick={onNewDir}>
            <Icon icon="lucide:folder-plus" width="16" height="16" aria-hidden="true" />
          </button>
        </div>
      </div>

      {rows.length === 0 && !busy ? <p className="s3__empty">这一格里没有东西</p> : null}

      {/* 只有表在滚：页脚那条翻页栏钉在栏底，滚到哪一行都读得出「本页几个」。转圈盖在表区这一层，不盖页脚 */}
      <div className="s3__stage">
        <div className="s3__scroll">
          <table className="s3__table">
            <thead>
              <tr>
                <th className="s3__idx">#</th>
                <th>名字</th>
                <th>大小</th>
                <th>改动时间</th>
                <th className="s3__acts-h">动作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.key}
                  className={r.kind === 'object' && r.key === selectedKey ? 's3__row--on' : ''}
                  onClick={() => (r.kind === 'prefix' ? onEnterPrefix(r.key) : onSelect(r))}
                >
                  {/* 行号按段记：每段都从 1 数起（判据 OS-057），目录行也算一行 */}
                  <td className="s3__idx" data-test={`idx:${r.key}`}>
                    {i + 1}
                  </td>
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
                        <RowIcon label="下载" test={`dl:${r.key}`} icon="lucide:download" onClick={() => onDownload(r)} />
                        <RowIcon label="复制临时链接" test={`link:${r.key}`} icon="lucide:link" onClick={() => onCopyLink(r)} />
                        <RowIcon label="重命名" test={`ren:${r.key}`} icon="lucide:pen-line" onClick={() => onRename(r)} />
                        <RowIcon label="删掉" test={`del:${r.key}`} icon="lucide:trash-2" onClick={() => onDelete(r)} />
                      </>
                    ) : (
                      /* 目录行只有一颗：删掉的是那个零字节标记，不是里面的对象（话在确认句里说） */
                      <RowIcon label="删掉目录" test={`rmdir:${r.key}`} icon="lucide:trash-2" onClick={() => onDeleteDir(r)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {loading ? (
          <div className="s3__loading" data-test="loading" aria-hidden="true">
            <span className="s3__spinner" />
          </div>
        ) : null}
      </div>

      <div className="s3__foot">
        <p className="s3__hint">
          {prefix === '' ? `${bucket} 的根` : `${bucket} / ${prefix}`}
        </p>
        <div className="s3__pager">
          <button type="button" className="icon-btn" data-test="prev" title="上一页" aria-label="上一页" disabled={pageIndex === 0 || busy} onClick={onPrev}>
            <Icon icon="lucide:chevron-left" width="16" height="16" aria-hidden="true" />
          </button>
          <span className="s3__page" data-test="page">
            本页 {rows.length} 个
          </span>
          <button type="button" className="icon-btn" data-test="next" title="下一页" aria-label="下一页" disabled={!hasNext || busy} onClick={onNext}>
            <Icon icon="lucide:chevron-right" width="16" height="16" aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  )
}

/** 行尾那颗图标键：图形来自 lucide 裁出的那一份，名字靠 title 与 aria-label 说话，`test` 是用例点得动它的那枚句柄 */
function RowIcon({ label, test, icon, onClick }: { label: string; test: string; icon: string; onClick: () => void }): JSX.Element {
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
      <Icon icon={icon} width="15" height="15" aria-hidden="true" />
    </button>
  )
}
