import { useEffect, useState, type JSX } from 'react'
import { useTheme } from '../../shell/theme'
import { markPerf } from '../../shell/shot'
import type { AppApi } from '@shared/protocol'
import { WSLC_MISSING, locateWslc, makeRunner, type WslcRunner } from './cli'
import { ContainersView } from './ContainersView'
import { ImagesView } from './ImagesView'
import './wsld.css'

/**
 * 容器台 —— wslc 的图形外壳。
 *
 * 两页：容器（列表 + 详情 + 生命周期动作 + 日志）与镜像（列表 + 拉取 + 删除）。
 * 数据与动作全靠 `wslc.exe`，路径由壳定位：应用只声明"我要用 wslc"，
 * 壳给不出路径就按"这台机器上没有 wslc"说话，其余界面照常。
 */

type Page = 'containers' | 'images'

export default function WsldApp({ api }: { api: AppApi }): JSX.Element {
  useTheme()

  const [runner, setRunner] = useState<WslcRunner | null>(null)
  const [checking, setChecking] = useState(true)
  const [page, setPage] = useState<Page>('containers')
  // 没去过的页不预先起进程读数据；去过之后留着——切来切去不冲掉选中项与正在跑的动作
  const [seen, setSeen] = useState<Record<Page, boolean>>({ containers: true, images: false })

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
      </div>

      {checking && (
        <div className="placeholder">
          <span className="spinner" />
          <span>正在找 wslc……</span>
        </div>
      )}

      {!checking && runner === null && (
        <div className="placeholder">
          <span className="wsld__missing">{WSLC_MISSING}</span>
        </div>
      )}

      {!checking && runner !== null && (
        <div className="wsld__pages">
          <div hidden={page !== 'containers'}>
            <ContainersView runner={runner} />
          </div>
          {seen.images && (
            <div hidden={page !== 'images'}>
              <ImagesView runner={runner} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
