import { useEffect, useState, type JSX } from 'react'
import { Titlebar } from '@airship/sdk'
import { useTheme, THEME_LABEL, nextThemeMode, type ThemeMode } from '@airship/sdk'
import { useReportShotReady } from '@airship/sdk'
import { capabilitiesPhrase, platformIssue, type Capability, type InstallResultView, type PackageProposalView } from '@airship/contract'
import type { InstalledApp, PlatformId } from '@airship/contract'

/**
 * 启动器。
 *
 * 就是一张应用格子：图标 + 名字，点开各自独立窗口。
 * 说明文字、能力标签、壳状态这些一概不放——要看的东西在应用自己里看。
 * 唯一的控件是右上角那颗主题键：三档循环，图标就是当前档。
 *
 * 应用名单**问主进程要**（`airshipShell.apps()`）：壳在运行期扫包根得到它。
 * 渲染侧不再自己扫一遍——过去两侧各 glob 一次、靠用例钉一致，
 * 现在只剩一份真源，那条钉法也就没有对象了（AP-008 因此退役）。
 *
 * 拖进来一个 `<id>.airship` 归档就装它（PK-015~019）：
 * 只有这一扇窗接受拖放，应用窗口不接受——否则任何一个页面拖一下就有装包权。
 * 装之前把清单里的能力念给人看；同 id 要覆盖必须先确认；装完不自动开窗口。
 */
export function Launcher(): JSX.Element {
  const { mode, setMode } = useTheme()
  const [platform, setPlatform] = useState<PlatformId | 'unknown' | null>(null)
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  /** 待确认的覆盖：一次拖多个时排队，同一时刻只挂一张卡片 */
  const [pending, setPending] = useState<{ file: File; proposal: PackageProposalView }[]>([])

  const reload = (): Promise<void> =>
    Promise.all([window.airshipShell.currentPlatform(), window.airshipShell.apps()])
      .then(([p, list]) => {
        setPlatform(p)
        setInstalled(list)
      })
      .catch((err: unknown) => {
        setPlatform('unknown')
        setInstalled([])
        setError(err instanceof Error ? err.message : String(err))
      })

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 清单没写 platforms = 全平台可用；写了就只在列出的平台进格子
  const entries = (installed ?? []).filter((e) => platformIssue(e.meta, platform ?? 'unknown') === null)

  useReportShotReady([entries.length])

  const open = (id: string): void => {
    setError(null)
    void window.airshipShell.openApp(id).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err))
    })
  }

  /** 装完那句：名字 + 能力。能力的说法只有一处真源（CAPABILITY_LABEL） */
  const sentence = (result: InstallResultView, capabilities: Capability[]): string => {
    const bits = [`已装：${result.name} · 能力：${capabilitiesPhrase(capabilities)}`]
    if (result.replaced) bits.push('换掉了原有的版本')
    return bits.join('；')
  }

  const drop = async (files: File[]): Promise<void> => {
    setError(null)
    setNotice(null)
    if (files.length === 0) {
      setError('拖进来的不是文件。只认单个 <id>.airship 归档，文件夹不支持。')
      return
    }

    const done: string[] = []
    const confirmations: { file: File; proposal: PackageProposalView }[] = []
    // 一次拖多个：逐个处理，一个失败不挡其余，最后各自有交代
    for (const file of files) {
      try {
        const proposal = await window.airshipShell.inspectPackage(file)
        if (proposal.replacing) {
          confirmations.push({ file, proposal })
          continue
        }
        const result = await window.airshipShell.installPackage(file, false)
        done.push(sentence(result, proposal.capabilities))
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    }

    await reload()
    if (done.length > 0) setNotice(done.join('　·　'))
    if (confirmations.length > 0) setPending(confirmations)
  }

  const head = pending[0] ?? null

  const decide = async (ok: boolean): Promise<void> => {
    if (!head) return
    setPending((rest) => rest.slice(1))
    if (!ok) {
      setNotice(`没动：${head.proposal.name}`)
      // 队列里还有别的待确认，卡片会自动接着显示下一张
      return
    }
    try {
      const result = await window.airshipShell.installPackage(head.file, true)
      await reload()
      setNotice(sentence(result, head.proposal.capabilities))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const next = nextThemeMode(mode)

  return (
    <div className="launcher">
      <Titlebar />

      <div
        className={`launcher__body${dragging ? ' launcher__body--drag' : ''}`}
        onDragOver={(e) => {
          // 不 preventDefault 就不会有 drop；拖到应用窗口上不接受（这里才是唯一的入口）
          e.preventDefault()
          if (!dragging) setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          void drop(Array.from(e.dataTransfer.files))
        }}
      >
        <div className="launcher__bar">
          {/* 纯图标键：悬停说明与无障碍名称是强制项，念得出"现在哪档、点一下换成哪档" */}
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setMode?.(next)}
            aria-label={`主题：${THEME_LABEL[mode]}，点一下换成${THEME_LABEL[next]}`}
            title={`主题：${THEME_LABEL[mode]}（点一下换成${THEME_LABEL[next]}）`}
          >
            <ThemeGlyph mode={mode} />
          </button>
        </div>

        {/* 拖进来时先给一句"松手就装"，让人知道这扇窗收这个东西 */}
        {dragging && (
          <div className="dropzone">松手就装：拖进来要是一个 <code>&lt;id&gt;.airship</code> 归档文件</div>
        )}

        {error && <div className="error">{error}</div>}
        {notice && <div className="hint notice">{notice}</div>}

        {head && (
          <div className="card confirm" role="alertdialog" aria-label="覆盖确认">
            <p>
              这台机器上已经装了 <strong>{head.proposal.replacing?.name ?? head.proposal.name}</strong>
              （{head.proposal.replacing?.sdkVersion}），要换成 {head.proposal.sdkVersion} 吗？
            </p>
            <p className="hint">
              新包的能力：{capabilitiesPhrase(head.proposal.capabilities)}
              {head.proposal.addedCapabilities.length > 0 &&
                `（比已装的多了：${capabilitiesPhrase(head.proposal.addedCapabilities)}）`}
            </p>
            <p className="hint">数据目录不会动；装完也不会自动打开。</p>
            <div className="row">
              <button type="button" className="btn btn--primary" onClick={() => void decide(true)}>
                覆盖
              </button>
              <button type="button" className="btn" onClick={() => void decide(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {installed !== null && entries.length === 0 && (
          <div className="placeholder">
            <div className="hint">这台机器上还没有装进壳的应用。</div>
            <div className="hint">开发时先跑 `just build-apps` 把包产到 dist-apps；运行时装的包在 %LOCALAPPDATA%\airship\apps。</div>
          </div>
        )}

        <div className="tiles">
          {entries.map(({ meta, iconUrl }) => (
            <button key={meta.id} type="button" className="tile" onClick={() => open(meta.id)}>
              <span className="tile__icon">
                {iconUrl ? <img src={iconUrl} alt="" className="tile__glyph" /> : null}
              </span>
              <span className="tile__name">{meta.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 三档各自的图形：跟随系统是半明半暗的圆（ Contrast 意思），暗是月牙，亮是太阳。
 * 都用 currentColor，跟着壳的文字色走，亮暗两档都不用另配色。
 */
function ThemeGlyph({ mode }: { mode: ThemeMode }): JSX.Element {
  const box = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  if (mode === 'dark') {
    // 月牙
    return (
      <svg {...box}>
        <path
          d="M10.2 1.6a6.4 6.4 0 1 0 4.2 8.6A5.2 5.2 0 0 1 10.2 1.6Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (mode === 'light') {
    // 太阳：中间一个圆，四周八道光芒
    return (
      <svg {...box}>
        <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M8 .9v1.9M8 13.2v1.9M.9 8h1.9M13.2 8h1.9M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13" />
        </g>
      </svg>
    )
  }
  // 跟随系统：一半实心一半空的圆
  return (
    <svg {...box}>
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4Z" fill="currentColor" />
    </svg>
  )
}
