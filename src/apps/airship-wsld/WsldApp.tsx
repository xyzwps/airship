import { useEffect, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import { markPerf } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import { WSLC_MISSING, locateWslc, makeRunner, type WslcRunner } from './cli'
import { ContainersView } from './ContainersView'
import { ImagesView } from './ImagesView'
import { RunView } from './RunView'
import './airship-wsld.css'

/**
 * wsld —— wslc 的图形外壳。
 *
 * 三页：容器（列表 + 详情 + 生命周期动作 + 日志）、镜像（列表 + 拉取 + 删除）、
 * 命令编排（`wslc run` 表单 + 就地执行 + 历史）。
 * 容器与镜像两页的数据与动作全靠 `wslc.exe`，路径由 runtime 定位：应用只声明"我要用 wslc"，
 * runtime 给不出路径就按"这台机器上没有 wslc"说话；编排页不依赖定位结果照常可用，
 * 只有「就地执行」按下时会说到那句缺 wslc 的话（RB-039）。
 */

type Page = 'containers' | 'images' | 'run'

export default function WsldApp({ api }: { api: AppApi }): JSX.Element {
  useTheme()

  const [runner, setRunner] = useState<WslcRunner | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState<Page>('containers')
  // 没去过的页不预先起进程读数据；去过之后留着——切来切去不冲掉选中项与正在跑的动作
  const [seen, setSeen] = useState<Record<Page, boolean>>({ containers: true, images: false, run: false })

  useEffect(() => {
    let alive = true
    void locateWslc(api)
      .then((exe) => {
        if (!alive) return
        setChecking(false)
        if (exe) {
          markPerf('wslc 已定位')
          setRunner(makeRunner(api, exe))
        }
      })
      .catch(() => {
        // 问路径这一步本身就失败（没声明 proc / 没声明工具）：同样按"用不了"说，不炸界面
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
    }
  }, [api])

  const open = (target: Page): void => {
    setPage(target)
    setSeen((prev) => (prev[target] ? prev : { ...prev, [target]: true }))
  }

  return (
    <div className="wsld">
      <div className="wsld__nav">
        <button
          type="button"
          className={`wsld__navbtn${page === 'containers' ? ' wsld__navbtn--on' : ''}`}
          onClick={() => open('containers')}
        >
          容器
        </button>
        <button
          type="button"
          className={`wsld__navbtn${page === 'images' ? ' wsld__navbtn--on' : ''}`}
          onClick={() => open('images')}
        >
          镜像
        </button>
        <button
          type="button"
          className={`wsld__navbtn${page === 'run' ? ' wsld__navbtn--on' : ''}`}
          data-test="页签-命令编排"
          onClick={() => open('run')}
        >
          命令编排
        </button>
      </div>

      {checking && (
        <div className="placeholder">
          <span className="spinner" />
          <span>正在找 wslc……</span>
        </div>
      )}

      {!checking && (
        <div className="wsld__pages">
          {seen.run && (
            <div hidden={page !== 'run'}>
              <RunView api={api} runner={runner} />
            </div>
          )}

          {page !== 'run' && runner === null && (
            <div className="placeholder">
              <span className="wsld__missing">{WSLC_MISSING}</span>
            </div>
          )}

          {runner !== null && (
            <>
              <div hidden={page !== 'containers'}>
                <ContainersView runner={runner} />
              </div>
              {seen.images && (
                <div hidden={page !== 'images'}>
                  <ImagesView runner={runner} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
