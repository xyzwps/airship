import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { useTheme } from '@airship/sdk'
import { useAppAutotest } from '@airship/sdk'
import { markPerf } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import { renderTrayIcon } from '@airship/sdk'
import {
  backgroundUrl,
  deleteBackground,
  exportToFile,
  importFromFile,
  loadTasks,
  pickBackground,
  saveTasks
} from './storage'
import { formatHeaderDate, formatTaskTimes, isToday } from './time'
import { createId, DEFAULT_ENCOURAGEMENT, type Task } from './types'
import './dagogo.css'

/**
 * 打勾勾 —— 桌面版。
 *
 * 与 Expo 版的差异，逐条说清：
 *   - 触觉反馈（Haptics）去掉：桌面没有震动马达。
 *   - 长按删除改成行内"删除"按钮：鼠标没有长按语义。
 *   - Android 桌面小组件改成托盘图标：显示今天勾掉几个，点击唤回窗口。
 *   - "分享文件"去掉：Windows 没有对应的系统分享面板，只保留"保存到文件"。
 *   - 主题跟随壳（亮/暗），不再自带独立开关；配色仍用打勾勾自己的暖色纸感。
 *   - 数据格式、导出文件结构与 Expo 版完全一致，老数据可直接导入。
 */
export default function DagogoApp({ api }: { api: AppApi }): JSX.Element {
  const { resolved } = useTheme()

  const [tasks, setTasks] = useState<Task[]>([])
  const [hydrated, setHydrated] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [editingTask, setEditingTask] = useState<Task | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [encouragement, setEncouragement] = useState(DEFAULT_ENCOURAGEMENT)
  const [editingEncouragement, setEditingEncouragement] = useState(false)
  const [encouragementDraft, setEncouragementDraft] = useState('')
  const [background, setBackground] = useState<string | null>(null)
  const [bgUrl, setBgUrl] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const tasksRef = useRef<Task[]>([])
  const saveErrorShown = useRef(false)

  const flash = useCallback((text: string) => {
    setNotice(text)
    setTimeout(() => setNotice(null), 2600)
  }, [])

  /* ---------- 托盘：替代 Android 小组件 ---------- */

  const syncTray = useCallback(
    (list: Task[]) => {
      const doneToday = list.filter((t) => t.completedAt && isToday(t.completedAt)).length
      void renderTrayIcon(String(doneToday), { done: doneToday > 0 })
        .then((iconDataUrl) =>
          api.tray.set({
            tooltip: `打勾勾 · 今天勾掉 ${doneToday} 个，共 ${list.length} 条`,
            iconDataUrl,
            focusOnClick: true
          })
        )
        .catch(() => undefined)
    },
    [api]
  )

  useEffect(() => {
    return () => {
      void api.tray.clear().catch(() => undefined)
    }
  }, [api])

  /* ---------- 载入设置与数据 ---------- */

  useEffect(() => {
    let alive = true

    void api.settings
      .get<{ encouragement?: string; background?: string | null }>('prefs', {
        encouragement: DEFAULT_ENCOURAGEMENT,
        background: null
      })
      .then((prefs) => {
        if (!alive) return
        if (prefs.encouragement?.trim()) setEncouragement(prefs.encouragement)
        setBackground(prefs.background ?? null)
      })
      .catch(() => undefined)

    void loadTasks(api)
      .then((loaded) => {
        if (!alive) return
        tasksRef.current = loaded
        setTasks(loaded)
        setHydrated(true)
        syncTray(loaded)
      })
      .catch((err: unknown) => {
        if (!alive) return
        setHydrated(true)
        setLoadError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      alive = false
    }
  }, [api, syncTray])

  useEffect(() => {
    let alive = true
    void backgroundUrl(api, background).then((url) => alive && setBgUrl(url))
    return () => {
      alive = false
    }
  }, [api, background])

  /* ---------- 改数据 ---------- */

  const commit = useCallback(
    (next: Task[]) => {
      tasksRef.current = next
      setTasks(next)
      syncTray(next)
      saveTasks(api, next).catch(() => {
        if (saveErrorShown.current) return
        saveErrorShown.current = true
        flash('保存失败：这次修改可能没写进本地文件')
      })
    },
    [api, flash, syncTray]
  )

  const handleAdd = () => {
    const title = draft.trim()
    if (!title || !hydrated) return
    const task: Task = { id: createId(), title, createdAt: new Date().toISOString(), completedAt: null }
    commit([task, ...tasksRef.current])
    setDraft('')
  }

  const handleToggle = (task: Task) => {
    const completing = task.completedAt === null
    commit(
      tasksRef.current.map((t) =>
        t.id === task.id ? { ...t, completedAt: completing ? new Date().toISOString() : null } : t
      )
    )
  }

  const handleDelete = (task: Task) => {
    if (!window.confirm(`删除「${task.title}」？录入和完成时间会一起删掉。`)) return
    commit(tasksRef.current.filter((t) => t.id !== task.id))
  }

  const saveEdit = () => {
    const title = editDraft.trim()
    if (!editingTask || !title) return
    if (title !== editingTask.title) {
      commit(tasksRef.current.map((t) => (t.id === editingTask.id ? { ...t, title } : t)))
    }
    setEditingTask(null)
    setEditDraft('')
  }

  /* ---------- 导入导出 / 背景 / 鼓励语 ---------- */

  const runExport = async () => {
    setBusy(true)
    try {
      const name = await exportToFile(api, tasksRef.current)
      if (name) flash(`已导出：${name}`)
    } catch (err) {
      flash(err instanceof Error ? err.message : '导出失败')
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    setBusy(true)
    try {
      const imported = await importFromFile(api)
      if (!imported) return
      // 导入是追加，不覆盖现有记录；id 冲突在归一化时已重排
      commit([...imported, ...tasksRef.current])
      flash(`导入 ${imported.length} 条`)
    } catch (err) {
      flash(err instanceof Error ? err.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  const runPickBackground = async () => {
    setBusy(true)
    try {
      const fileName = await pickBackground(api)
      if (!fileName) return
      const previous = background
      setBackground(fileName)
      void api.settings.set('prefs', { encouragement, background: fileName })
      if (previous) void deleteBackground(api, previous)
    } catch (err) {
      flash(err instanceof Error ? err.message : '设置背景失败')
    } finally {
      setBusy(false)
    }
  }

  const runClearBackground = async () => {
    const previous = background
    setBackground(null)
    void api.settings.set('prefs', { encouragement, background: null })
    if (previous) void deleteBackground(api, previous)
  }

  const saveEncouragement = () => {
    const text = encouragementDraft.trim()
    if (!text) return
    setEncouragement(text)
    setEditingEncouragement(false)
    void api.settings.set('prefs', { encouragement: text, background })
  }

  /* ---------- 截图模式自动化：真数据验证 ---------- */

  useAppAutotest(
    'dagogo',
    async () => {
      // 造三条记录（两条待办、一条今天已完成），走真实的存盘 + 托盘链路
      const now = new Date()
      const earlier = new Date(now.getTime() - 3600_000).toISOString()
      const sample: Task[] = [
        { id: 't1', title: '把周报发出去', createdAt: earlier, completedAt: null },
        { id: 't2', title: '给妈妈回电话', createdAt: earlier, completedAt: null },
        { id: 't3', title: '交水电费', createdAt: earlier, completedAt: now.toISOString() }
      ]
      await saveTasks(api, sample)
      markPerf('三条记录存盘完成')
      tasksRef.current = sample
      setTasks(sample)
      syncTray(sample)
    },
    setNotice
  )

  /* ---------- 渲染 ---------- */

  const pending = tasks.filter((t) => t.completedAt === null)
  const done = tasks.filter((t) => t.completedAt !== null)
  const doneToday = done.filter((t) => t.completedAt && isToday(t.completedAt)).length

  return (
    <div className="dagogo" data-mode={resolved}>
      {bgUrl && <div className="dagogo__bg" style={{ backgroundImage: `url("${bgUrl}")` }} />}

      <div className="dagogo__inner">
        <header className="dagogo__head">
          <div>
            <div className="dagogo__date">{formatHeaderDate()}</div>
            {editingEncouragement ? (
              <div className="row" style={{ marginTop: 6 }}>
                <input
                  className="input dagogo__enc-input"
                  value={encouragementDraft}
                  autoFocus
                  onChange={(e) => setEncouragementDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && saveEncouragement()}
                />
                <button type="button" className="btn btn--primary" onClick={saveEncouragement}>
                  保存
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setEditingEncouragement(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="dagogo__enc"
                title="点击修改这句话"
                onClick={() => {
                  setEncouragementDraft(encouragement)
                  setEditingEncouragement(true)
                }}
              >
                {encouragement}
              </button>
            )}
          </div>

          <div className="row">
            <span className="dagogo__count">
              今天 {doneToday} / {tasks.length}
            </span>
            <button type="button" className="btn btn--ghost" onClick={() => setPanelOpen((v) => !v)}>
              {panelOpen ? '收起' : '数据'}
            </button>
          </div>
        </header>

        {panelOpen && (
          <div className="dagogo__panel card">
            <div className="row row--wrap">
              <button type="button" className="btn" disabled={busy} onClick={() => void runExport()}>
                导出到文件
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void runImport()}>
                从文件导入
              </button>
              <span className="spacer" />
              <button type="button" className="btn" disabled={busy} onClick={() => void runPickBackground()}>
                换背景图
              </button>
              {background && (
                <button type="button" className="btn btn--ghost" onClick={() => void runClearBackground()}>
                  去掉背景
                </button>
              )}
            </div>
            <p className="hint" style={{ margin: '8px 0 0' }}>
              导出格式与手机版一致（app: 打勾勾 / version: 1），两边可互导。
            </p>
          </div>
        )}

        {notice && <div className="dagogo__notice">{notice}</div>}
        {loadError && <div className="dagogo__notice dagogo__notice--bad">读取失败：{loadError}</div>}

        <div className="dagogo__add row">
          <input
            className="input dagogo__add-input"
            placeholder="记一件要做的事，回车添加"
            value={draft}
            disabled={!hydrated}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          />
          <button type="button" className="btn btn--primary" disabled={!hydrated || !draft.trim()} onClick={handleAdd}>
            添加
          </button>
        </div>

        {!hydrated ? (
          <div className="placeholder">
            <div className="spinner" />
          </div>
        ) : tasks.length === 0 ? (
          <div className="dagogo__empty">还没有记录。上面写一件，回车就行。</div>
        ) : (
          <div className="dagogo__lists">
            <TaskSection
              label="待办"
              tasks={pending}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={(t) => {
                setEditingTask(t)
                setEditDraft(t.title)
              }}
            />
            <TaskSection
              label="已完成"
              tasks={done}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onEdit={(t) => {
                setEditingTask(t)
                setEditDraft(t.title)
              }}
            />
          </div>
        )}
      </div>

      {editingTask && (
        <div className="dagogo__modal" onClick={() => setEditingTask(null)}>
          <div className="dagogo__modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="card__title">编辑</div>
            <input
              className="input"
              style={{ width: '100%' }}
              value={editDraft}
              autoFocus
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveEdit()}
            />
            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn--ghost" onClick={() => setEditingTask(null)}>
                取消
              </button>
              <button type="button" className="btn btn--primary" disabled={!editDraft.trim()} onClick={saveEdit}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface SectionProps {
  label: string
  tasks: Task[]
  onToggle: (task: Task) => void
  onDelete: (task: Task) => void
  onEdit: (task: Task) => void
}

function TaskSection({ label, tasks, onToggle, onDelete, onEdit }: SectionProps): JSX.Element | null {
  if (tasks.length === 0) return null
  return (
    <section className="dagogo__section">
      <div className="dagogo__section-head">
        <span className="dagogo__section-label">{label}</span>
        <span className="dagogo__rule" />
        <span className="dagogo__section-count">{tasks.length}</span>
      </div>
      <div className="dagogo__card">
        {tasks.map((task, i) => (
          <div key={task.id} className={`dagogo__row${i > 0 ? ' dagogo__row--divided' : ''}`}>
            <button
              type="button"
              className={`dagogo__check${task.completedAt ? ' dagogo__check--done' : ''}`}
              aria-label={task.completedAt ? `取消完成 ${task.title}` : `完成 ${task.title}`}
              onClick={() => onToggle(task)}
            >
              {task.completedAt ? '✓' : ''}
            </button>
            <div className="dagogo__text">
              <div className={`dagogo__title${task.completedAt ? ' dagogo__title--done' : ''}`}>{task.title}</div>
              <div className="dagogo__meta">{formatTaskTimes(task.createdAt, task.completedAt)}</div>
            </div>
            <div className="dagogo__actions">
              <button type="button" className="btn btn--ghost" onClick={() => onEdit(task)}>
                编辑
              </button>
              <button type="button" className="btn btn--ghost dagogo__del" onClick={() => onDelete(task)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
