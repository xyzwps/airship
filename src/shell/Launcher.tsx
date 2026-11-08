import { useEffect, useState, type JSX } from 'react'
import { Titlebar } from '@airship/sdk'
import { useTheme, THEME_LABEL, nextThemeMode, Glyph, type ThemeMode } from '@airship/sdk'
import { useReportShotReady } from '@airship/sdk'
import { capabilitiesPhrase, platformIssue, PACKAGE_ROOT_LABEL, type Capability, type InstallResultView, type InstalledApp, type PackageProposalView, type ShellInfoView, type UninstallResultView } from '@airship/contract'
import type { PlatformId } from '@airship/contract'

/**
 * 启动器。
 *
 * 就是一张应用格子：图标 + 名字，点开各自独立窗口。
 * 说明文字、能力标签、壳状态这些一概不放——要看的东西在应用自己里看。
 *
 * 应用名单**问主进程要**（`airshipShell.apps()`）：壳在运行期扫包根得到它。
 * 渲染侧不再自己扫一遍——过去两侧各 glob 一次、靠用例钉一致，
 * 现在只剩一份真源，那条钉法也就没有对象了（AP-008 因此退役）。
 *
 * 右上角两颗键：主题键三档循环，图标就是当前档；设置键把整屏换成设置那一页。
 * 版本与包根只在设置页念——格子里照旧一条壳状态都不放（SH-001），
 * 要看的东西在另一屏看，不是往格子上堆。
 *
 * 拖进来一个 `<id>.airship` 归档就装它（PK-015~019）：
 * 只有这一扇窗接受拖放，应用窗口不接受——否则任何一个页面拖一下就有装包权。
 * 装之前把清单里的能力念给人看；同 id 要覆盖必须先确认；装完不自动开窗口。
 *
 * 卸载走顶栏那颗管理键（PK-021~026 / SH-025~029）：按下它，每格右上角露一个叉、
 * 整格变成"点它是要卸它"而不是"点它是要开它"——一格里同一时刻只有一个动作，
 * 所以格子内不摆第二颗可点的键，叉只是画在上面的记号。再按一下退回普通格子，
 * 进设置那一屏也退回（回来的该是原来那些格，见 SH-029）。
 * 点格子弹的是确认卡片：删代码还是连数据一起删，由人当场选；没点确认磁盘一个字节不动。
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
  /** 管理态：格子里露出卸载记号，点格子变成"要卸它" */
  const [managing, setManaging] = useState(false)
  /** 待确认的卸载：一次只挂一张卡片（卸载是逐个动作，不排队） */
  const [removing, setRemoving] = useState<InstalledApp | null>(null)
  /** 两屏：格子与设置。设置那一屏的数据在进那一屏时才问主进程要（版本与包根不会自己变） */
  const [view, setView] = useState<'grid' | 'settings'>('grid')
  const [info, setInfo] = useState<ShellInfoView | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)

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

  // 每次进设置那一屏都问一次：装包、改环境变量这些动作不会让这一屏自己过期，重进就该重新问
  useEffect(() => {
    if (view !== 'settings') return
    let alive = true
    window.airshipShell
      .shellInfo()
      .then((v) => {
        if (!alive) return
        setInfo(v)
        setInfoError(null)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setInfo(null)
        setInfoError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [view])

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

  /** 卸载那一行：名字 + 卸的是哪一档根 + 数据的下落；另一档根顶上时必须念出来 */
  const uninstallSentence = (result: UninstallResultView): string => {
    const data = result.dataRemoved ? '数据也删了' : result.dataWasAbsent ? '本来就没有它的数据' : '数据留着'
    const bits = [`已卸载：${result.name} · 来自${PACKAGE_ROOT_LABEL[result.origin]} · ${data}`]
    if (result.tookOverByOtherRoot) bits.push('另一档根里还有一份，现在生效的是它')
    return bits.join('；')
  }

  const askRemove = (app: InstalledApp): void => {
    setError(null)
    setNotice(null)
    setRemoving(app)
  }

  /** 卡片上那两颗键的差别只有一件事：数据这一族删不删。归档那一份都要删。 */
  const confirmRemove = async (purgeData: boolean): Promise<void> => {
    const target = removing
    if (!target) return
    setRemoving(null)
    try {
      const result = await window.airshipShell.uninstallPackage(target.meta.id, purgeData)
      await reload()
      setNotice(uninstallSentence(result))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const toggleManaging = (): void => {
    setManaging((on) => !on)
    setRemoving(null)
  }

  const openSettings = (): void => {
    // 管理态不带进设置那一屏：从那一屏回来该是原来那些格（SH-024）
    setManaging(false)
    setRemoving(null)
    setView('settings')
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
        <div className={`launcher__bar${view === 'settings' ? ' launcher__bar--start' : ''}`}>
          {view === 'settings' ? (
            /* 设置那一屏只留回得去这一颗：主题键在格子上，两屏不摆同一排控件 */
            <button
              type="button"
              className="bar-btn"
              data-test="返回应用格子"
              onClick={() => setView('grid')}
              aria-label="返回应用格子"
              title="返回应用格子"
            >
              <Glyph name="back" />
            </button>
          ) : (
            <>
              {/* 一颗键两态：图形不换，换的是"按下去"那块底色与悬停说明念的那句话 */}
              <button
                type="button"
                className={`bar-btn${managing ? ' bar-btn--on' : ''}`}
                data-test="卸载管理"
                aria-pressed={managing}
                onClick={toggleManaging}
                aria-label={managing ? '退出卸载管理：格子回到点开就开窗口' : '卸载管理：点一下，每格露出卸载记号'}
                title={managing ? '退出卸载管理：格子回到点开就开窗口' : '卸载管理：点一下，每格露出卸载记号'}
              >
                <Glyph name="remove" />
              </button>
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
              <button
                type="button"
                className="bar-btn"
                data-test="设置"
                onClick={openSettings}
                aria-label="设置"
                title="打开设置页：版本与应用装在哪个目录"
              >
                <GearGlyph />
              </button>
            </>
          )}
        </div>

        {/* 拖进来时先给一句"松手就装"，让人知道这扇窗收这个东西。两屏都要给：落点始终是这一扇窗 */}
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

        {removing && (
          <div className="card confirm" role="alertdialog" aria-label="卸载确认">
            <p>
              卸载 <strong>{removing.meta.name}</strong>？
              删掉的是{PACKAGE_ROOT_LABEL[removing.origin]}里那一份 <code>{removing.meta.id}.airship</code> 归档。
            </p>
            <p className="hint">
              它的数据（自己存的那些东西）另算：只卸载就原样留着，重装还能接着用；连数据一起删就回不来了。
            </p>
            <div className="row">
              <button type="button" className="btn btn--primary" data-test="只卸载" onClick={() => void confirmRemove(false)}>
                只卸载
              </button>
              <button type="button" className="btn btn--danger" data-test="卸载并删数据" onClick={() => void confirmRemove(true)}>
                卸载并删数据
              </button>
              <button type="button" className="btn" data-test="取消卸载" onClick={() => setRemoving(null)}>
                取消
              </button>
            </div>
          </div>
        )}

        {view === 'settings' ? (
          <SettingsScreen info={info} error={infoError} />
        ) : (
          <>
            {installed !== null && entries.length === 0 && (
              <div className="placeholder">
                <div className="hint">这台机器上还没有装进壳的应用。</div>
                <div className="hint">开发时先跑 `just build-apps` 把包产到 dist-apps；运行时装的包在 %LOCALAPPDATA%\airship\apps。</div>
              </div>
            )}

            <div className="tiles">
              {entries.map((app) => (
                <button
                  key={app.meta.id}
                  type="button"
                  className={`tile${managing ? ' tile--manage' : ''}`}
                  data-test={managing ? `卸载 ${app.meta.id}` : undefined}
                  onClick={() => (managing ? askRemove(app) : open(app.meta.id))}
                  aria-label={managing ? `卸载 ${app.meta.name}` : undefined}
                  title={managing ? `卸载 ${app.meta.name}` : undefined}
                >
                  <span className="tile__icon">
                    {app.iconUrl ? <img src={app.iconUrl} alt="" className="tile__glyph" /> : null}
                  </span>
                  <span className="tile__name">{app.meta.name}</span>
                  {/* 管理态里的叉只是画在格子角上的记号：一格里同一时刻只有一个动作，
                      所以这里不再嵌第二颗可点的键（能点的整格就是那颗键） */}
                  {managing && (
                    <span className="tile__mark" aria-hidden="true">
                      <CrossGlyph />
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * 设置那一屏：两行——这版壳是什么，应用装在哪个目录。
 *
 * 表来自主进程扫的那一份，界面不自己拼路径：`应用安装目录`总有一行，`开发包根`
 * 只在"这台机器上真有这一档根"时多一行（发布版压根不会带它，见 PK-012）。
 * 措辞取自 `PACKAGE_ROOT_LABEL`，与日志里"来自哪个根"那句是同一份。
 * 路径等宽、可整行选中——念出来不能复制，等于没念。
 */
function SettingsScreen({ info, error }: { info: ShellInfoView | null; error: string | null }): JSX.Element {
  if (error !== null) return <div className="error">{error}</div>
  if (info === null) return <div className="hint">正在问主进程…</div>
  return (
    <div className="settings">
      <div className="settings__title">设置</div>
      <div className="settings__row">
        <span className="settings__label">版本</span>
        <span className="settings__value mono">{info.shellVersion}</span>
      </div>
      {info.roots.map((root) => (
        <div key={root.origin} className="settings__row">
          <span className="settings__label">{PACKAGE_ROOT_LABEL[root.origin]}</span>
          <span className="settings__value mono selectable">{root.dir}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * 格角上的叉：两条对角线，不套圆框——顶栏那颗管理键是垃圾桶，两形不撞。
 * 用 currentColor，跟着壳的文字色走。
 */
function CrossGlyph(): JSX.Element {
  return (
    <svg width={11} height={11} viewBox="0 0 16 16" aria-hidden={true}>
      <path
        d="M3.6 3.6l8.8 8.8M12.4 3.6 3.6 12.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * 齿轮：一圈六齿 + 中心一个毂，齿都贴着环——主题键那颗太阳的光芒是离开圆的，
 * 两颗键并排摆着不能撞形。都用 currentColor，跟着壳的文字色走。
 */
function GearGlyph(): JSX.Element {
  const box = { width: 15, height: 15, viewBox: '0 0 16 16', 'aria-hidden': true } as const
  const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round' } as const
  return (
    <svg {...box}>
      <circle cx="8" cy="8" r="4.2" {...stroke} />
      <circle cx="8" cy="8" r="1.7" {...stroke} />
      <path d="M12.2 8h2M3.8 8h-2M10.1 11.64l1 1.73M5.9 11.64l-1 1.73M10.1 4.36l1-1.73M5.9 4.36l-1-1.73" {...stroke} />
    </svg>
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
