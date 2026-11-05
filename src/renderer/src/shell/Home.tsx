import { useEffect, useState, type JSX } from 'react'
import { APPS, APP_MAP } from '@shared/registry'
import type { AppId } from '@shared/protocol'
import { AppIcon } from './AppIcon'

interface ShellCtl {
  ffmpegPath(): Promise<string | null>
  grants(app: AppId): Promise<{ read: number; write: number }>
}

/**
 * 总览页。
 *
 * 只放三样东西：能进哪些应用、壳当前的关键状态（ffmpeg 在不在）、
 * 以及数据落在哪。不放说明文字堆——每个应用的说明在卡片上的一句话里。
 */
export function Home({ onOpen }: { onOpen: (id: AppId) => void }): JSX.Element {
  const [ffmpeg, setFfmpeg] = useState<string | null | undefined>(undefined)
  const [dataDir, setDataDir] = useState<string>('')
  const [version, setVersion] = useState<string>('')

  useEffect(() => {
    let alive = true
    const ctl = (window as unknown as { airshipShell?: ShellCtl }).airshipShell
    void ctl?.ffmpegPath().then((p) => alive && setFfmpeg(p))
    void window.airship.paths('vcp').then((p) => {
      if (!alive) return
      setDataDir(p.root)
      setVersion(p.shellVersion)
    })
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="app-frame">
      <div className="home">
        <h1 className="home__title">飞船</h1>
        <p className="home__sub">一个壳，里面装着自用的几个应用。</p>

        <div className="home__grid">
          {APPS.map((meta) => (
            <button
              key={meta.id}
              type="button"
              className="appcard"
              style={{ ['--nav-accent' as string]: meta.accent }}
              onClick={() => onOpen(meta.id)}
            >
              <div className="appcard__head">
                <AppIcon meta={meta} className="appcard__icon" />
                <span className="appcard__name">{meta.name}</span>
              </div>
              <span className="appcard__desc">{meta.description}</span>
              <div className="appcard__caps">
                {meta.capabilities.map((c) => (
                  <span key={c} className="cap">
                    {c}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="card" style={{ marginTop: 22 }}>
          <h2 className="card__title">壳状态</h2>
          <div className="field-grid">
            <label>ffmpeg</label>
            <div className="row">
              {ffmpeg === undefined ? (
                <span className="hint">探测中…</span>
              ) : ffmpeg ? (
                <>
                  <span className="chip chip--ok">可用</span>
                  <span className="mono hint" title={ffmpeg}>
                    {ffmpeg.split(/[\\/]/).pop()}
                  </span>
                </>
              ) : (
                <>
                  <span className="chip chip--bad">没找到</span>
                  <span className="hint">vcp 不可用，可在设置里手动指定</span>
                </>
              )}
            </div>

            <label>数据目录</label>
            <span className="mono hint selectable" title={dataDir}>
              {dataDir}
            </span>

            <label>应用</label>
            <span className="hint">
              {APPS.length} 个：{APPS.map((a) => APP_MAP[a.id]!.name).join('、')}
            </span>

            <label>版本</label>
            <span className="mono hint">{version}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
