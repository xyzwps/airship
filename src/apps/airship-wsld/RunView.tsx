import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { IconButton } from '@airship/sdk'
import type { AppApi } from '@airship/contract'
import { WSLC_MISSING, loadImages, nextJobId, type WslcRunner } from './cli'
import { cleanWslcError, errorMessage } from './parse'
import { imageIsTagged, imageReference } from './model'
import { useShellEvents } from './hooks'
import {
  PULL_POLICIES,
  describeRunIssue,
  emptyRunSpec,
  recordRunHistory,
  runArgs,
  runCommand,
  tryParseRun,
  validateRunSpec,
  newEnvRow,
  newLabelRow,
  newPathRow,
  newPortRow,
  newVolumeRow,
  type EnvRow,
  type LabelRow,
  type PathRow,
  type PortRow,
  type RunHistoryEntry,
  type RunSpec,
  type VolumeRow
} from './run'

/**
 * 「命令编排」页（RB 册子的影子）。
 *
 * 表单是唯一真源：命令、校验、可点性全从同一份 RunSpec 现算（RB-003/008）。
 * 这一页在没有 wslc 的机器上照常可用——填表、拼命令、复制、读回都不碰进程；
 * 只有「就地执行」按下时说那句"这台机器上没有 wslc"。
 */

const COPY_OK = '命令已复制到剪贴板。'
const COPY_FAIL = '复制到剪贴板失败，请手动选中命令文本。'
const CLIP_EMPTY = '剪贴板里没有文本，先复制一条 wslc run 命令再来。'
const NOT_RUN = '这不是 wslc run 命令，没法读回来。'
const IMPORTED = '已从剪贴板读回命令，可以继续在表单里改。'
const FROM_HISTORY = '已从执行历史读回命令，可以继续在表单里改。'
const RESTORE_BUSY = '正在执行，先取消或等它跑完再恢复历史。'
const RUNNING = '正在执行…'
const KILLED = '已终止 wslc 进程；前台跑的容器可能已随之退出，请到容器页确认。'
const OUT_EMPTY = '执行后，wslc 的输出显示在这里。'
const HISTORY_EMPTY = '还没有就地执行过命令。执行过的命令按最新在前留在这里，最多 100 条。'
const ISSUES_HEAD = '还差这些就能执行：'
const RAN_NO_ID = '容器已启动（没拿到 ID，可到「容器」页查看）。'

const TIP_KILL = '终止 wslc 进程（已在后台跑起来的容器不会因此停下，去容器页管理）'
const TIP_RESTORE = '把这条命令填回表单，继续编辑'
const TIP_CLEAR = '一键清空整张表单，回到初始状态'
const TIP_IMPORT = '把剪贴板里的 wslc run 命令读回来，继续在表单里改'
const TIP_COPY = '把这条命令复制到剪贴板，可直接粘进终端跑'

const PH_IMAGE = '从本机镜像里选，或直接输入引用，例如 redis:7'
const PH_PORT = '例如 8080 或 8000-8010'
const PH_ARGS = '按空格分词；片段带空格时用引号包住'
const PH_EXTRA = '例如 --gpus all --dns 8.8.8.8'

interface RowMap {
  ports: PortRow
  volumes: VolumeRow
  envVars: EnvRow
  labels: LabelRow
  tmpfsPaths: PathRow
}

type ListKey = keyof RowMap

const NEW_ROW: Record<ListKey, () => RowMap[ListKey]> = {
  ports: newPortRow,
  volumes: newVolumeRow,
  envVars: newEnvRow,
  labels: newLabelRow,
  tmpfsPaths: newPathRow
}

interface ExecJob {
  jobId: string
  /** 按下执行那一刻勾的是后台还是前台：收尾那句话由它决定 */
  detach: boolean
}

interface Props {
  api: AppApi
  /** 没有 wslc 也照常渲染：只有「就地执行」会说到它 */
  runner: WslcRunner | null
}

export function RunView({ api, runner }: Props): JSX.Element {
  const [spec, setSpec] = useState<RunSpec>(emptyRunSpec)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [output, setOutput] = useState<string[]>([])
  const [executed, setExecuted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<RunHistoryEntry[]>([])
  const [candidates, setCandidates] = useState<string[]>([])

  const busyRef = useRef(false)
  const job = useRef<ExecJob | null>(null)
  const stoppedByUser = useRef(false)
  const partial = useRef('')
  const stdoutRaw = useRef('')
  const stderrRaw = useRef('')
  const box = useRef<HTMLPreElement | null>(null)
  const candidatesFetched = useRef(false)

  const command = runCommand(spec)
  const issues = validateRunSpec(spec)
  const canRun = issues.length === 0

  const patch = useCallback((part: Partial<RunSpec>): void => {
    setSpec((s) => ({ ...s, ...part }))
  }, [])

  const addList = useCallback((key: ListKey): void => {
    setSpec((s) => ({ ...s, [key]: [...s[key], NEW_ROW[key]()] }))
  }, [])

  const dropList = useCallback((key: ListKey, index: number): void => {
    setSpec((s) => ({ ...s, [key]: s[key].filter((_, i) => i !== index) }))
  }, [])

  const setList = useCallback(<K extends ListKey>(key: K, index: number, part: Partial<RowMap[K]>): void => {
    setSpec((s) => ({ ...s, [key]: s[key].map((row, i) => (i === index ? { ...row, ...part } : row)) }))
  }, [])

  /* ---------------- 镜像候选：搭手，不是拦路（RB-038/039） ---------------- */

  useEffect(() => {
    if (!runner || candidatesFetched.current) return
    candidatesFetched.current = true
    void loadImages(runner)
      .then((list) => setCandidates(list.filter(imageIsTagged).map(imageReference)))
      .catch(() => {
        // 取不到就空着：手打永远不受影响，也不弹错
      })
  }, [runner])

  /* ---------------- 复制与读回（RB-025~033） ---------------- */

  const copy = async (): Promise<void> => {
    try {
      await api.clipboard.writeText(command)
      setNotice(COPY_OK)
      setError('')
    } catch {
      setNotice('')
      setError(COPY_FAIL)
    }
  }

  const importFromClipboard = async (): Promise<void> => {
    if (busyRef.current) return
    let text = ''
    try {
      text = await api.clipboard.readText()
    } catch (err) {
      setError(errorMessage(err))
      return
    }
    if (text.trim().length === 0) {
      setNotice('')
      setError(CLIP_EMPTY)
      return
    }
    const parsed = tryParseRun(text)
    if (parsed === null) {
      // 读不懂的一律不动表单（RB-029）
      setNotice('')
      setError(NOT_RUN)
      return
    }
    setSpec(parsed)
    setNotice(IMPORTED)
    setError('')
  }

  /* ---------------- 就地执行（RB-020~024、042） ---------------- */

  const execute = (): void => {
    if (busyRef.current || !canRun) return
    if (runner === null) {
      // 表单照常能用，只有这一步要说这句话；没跑起来的不算执行过，不进历史
      setNotice('')
      setError(WSLC_MISSING)
      return
    }
    // 按下即记、不问成败（RB-042）
    setHistory((prev) => recordRunHistory(prev, runCommand(spec), Date.now()))

    const jobId = nextJobId('run')
    job.current = { jobId, detach: spec.detach }
    busyRef.current = true
    setBusy(true)
    stoppedByUser.current = false
    partial.current = ''
    stdoutRaw.current = ''
    stderrRaw.current = ''
    setOutput([])
    setExecuted(true)
    setNotice('')
    setError('')

    void runner.start(jobId, runArgs(spec)).catch((err: unknown) => {
      job.current = null
      busyRef.current = false
      setBusy(false)
      setError(errorMessage(err))
    })
  }

  const kill = (): void => {
    const current = job.current
    if (!current) return
    stoppedByUser.current = true
    void api.proc.kill(current.jobId).catch(() => undefined)
  }

  const clearAll = (): void => {
    if (busyRef.current) return
    setSpec(emptyRunSpec())
    setOutput([])
    setExecuted(false)
    setNotice('')
    setError('')
  }

  const restore = (entry: RunHistoryEntry): void => {
    if (busyRef.current) {
      setNotice('')
      setError(RESTORE_BUSY)
      return
    }
    const parsed = tryParseRun(entry.command)
    if (parsed === null) {
      setNotice('')
      setError(NOT_RUN)
      return
    }
    setSpec(parsed)
    setNotice(FROM_HISTORY)
    setError('')
  }

  /* ---------------- 事件回流 ---------------- */

  const appendLines = (incoming: string[]): void => {
    if (incoming.length === 0) return
    setOutput((prev) => prev.concat(incoming))
  }

  /** chunk 的尾巴常常是半行：先攒着，凑完整再上屏 */
  const ingest = (text: string, sink: (line: string) => void): void => {
    partial.current += text
    const pieces = partial.current.split('\n')
    partial.current = pieces.pop() ?? ''
    pieces.forEach((line) => sink(line.endsWith('\r') ? line.slice(0, -1) : line))
  }

  useShellEvents(api, (event) => {
    const current = job.current
    if (!current) return

    if (event.kind === 'proc:chunk') {
      if (event.jobId !== current.jobId) return
      if (event.stream === 'stdout') {
        stdoutRaw.current += event.text
        ingest(event.text, (line) => appendLines([line]))
      } else {
        // stderr 不进输出框：那句话清洗后由错误条说，别让样板话留在屏上（RB-024）
        stderrRaw.current += event.text
      }
      return
    }

    if (event.kind !== 'proc:exit' || event.jobId !== current.jobId) return

    const rest = partial.current.replace(/\r$/, '')
    partial.current = ''
    if (rest.length > 0) appendLines([rest])

    job.current = null
    busyRef.current = false
    setBusy(false)

    if (stoppedByUser.current) {
      stoppedByUser.current = false
      setNotice(KILLED)
      return
    }
    if (event.result.code !== 0) {
      setError(cleanWslcError(stderrRaw.current))
      return
    }
    if (current.detach) {
      const id = stdoutRaw.current
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      setNotice(id ? `已运行容器 ${id}，可到「容器」页查看。` : RAN_NO_ID)
    }
  })

  // 输出框停在最新写入的那一行（RB-051）
  useEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [output])

  /* ---------------- 呈现 ---------------- */

  return (
    <div className="wsld__page wsld__run">
      <div className="wsld__run-cols">
        <div className="wsld__run-form">
          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">基本信息</h3>
            <label className="wsld__run-field">
              <span className="wsld__field">镜像</span>
              <input
                className="input"
                data-test="编排-镜像"
                aria-label="镜像"
                placeholder={PH_IMAGE}
                list="wsld-run-images"
                value={spec.image}
                onChange={(e) => patch({ image: e.target.value })}
              />
              <datalist id="wsld-run-images">
                {candidates.map((ref) => (
                  <option key={ref} value={ref} />
                ))}
              </datalist>
            </label>
            <label className="wsld__run-field">
              <span className="wsld__field">容器名称 (--name)</span>
              <input
                className="input"
                data-test="编排-名称"
                aria-label="容器名称 (--name)"
                value={spec.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <div className="wsld__run-checks">
              <label className="wsld__check">
                <input
                  type="checkbox"
                  data-test="编排-后台"
                  aria-label="后台运行 (-d)"
                  checked={spec.detach}
                  onChange={(e) => patch({ detach: e.target.checked })}
                />
                <span>后台运行 (-d)</span>
              </label>
              <label className="wsld__check">
                <input
                  type="checkbox"
                  data-test="编排-自动删除"
                  aria-label="停止后自动删除 (--rm)"
                  checked={spec.rm}
                  onChange={(e) => patch({ rm: e.target.checked })}
                />
                <span>停止后自动删除 (--rm)</span>
              </label>
              <label className="wsld__check">
                <input
                  type="checkbox"
                  data-test="编排-标准输入"
                  aria-label="保持标准输入 (-i)"
                  checked={spec.interactive}
                  onChange={(e) => patch({ interactive: e.target.checked })}
                />
                <span>保持标准输入 (-i)</span>
              </label>
              <label className="wsld__check">
                <input
                  type="checkbox"
                  data-test="编排-伪终端"
                  aria-label="分配伪终端 (-t)"
                  checked={spec.tty}
                  onChange={(e) => patch({ tty: e.target.checked })}
                />
                <span>分配伪终端 (-t)</span>
              </label>
              <label className="wsld__check">
                <input
                  type="checkbox"
                  data-test="编排-全部端口"
                  aria-label="发布镜像暴露的全部端口 (-P)"
                  checked={spec.publishAll}
                  onChange={(e) => patch({ publishAll: e.target.checked })}
                />
                <span>发布全部端口 (-P)</span>
              </label>
            </div>
            <label className="wsld__run-field">
              <span className="wsld__field">拉取策略 (--pull)</span>
              <select
                className="select"
                data-test="编排-拉取"
                aria-label="拉取策略 (--pull)"
                value={spec.pullPolicy}
                onChange={(e) => patch({ pullPolicy: e.target.value })}
              >
                <option value="">默认（缺了才拉）</option>
                {PULL_POLICIES.map((policy) => (
                  <option key={policy} value={policy}>
                    {policy}
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">初始化命令</h3>
            <label className="wsld__run-field">
              <span className="wsld__field">入口程序 (--entrypoint)</span>
              <input
                className="input"
                data-test="编排-入口"
                aria-label="入口程序 (--entrypoint)"
                value={spec.entrypoint}
                onChange={(e) => patch({ entrypoint: e.target.value })}
              />
            </label>
            <label className="wsld__run-field">
              <span className="wsld__field">命令</span>
              <input
                className="input"
                data-test="编排-容器命令"
                aria-label="命令"
                value={spec.command}
                onChange={(e) => patch({ command: e.target.value })}
              />
            </label>
            <textarea
              className="input wsld__run-area"
              data-test="编排-参数"
              aria-label="参数"
              rows={2}
              placeholder={PH_ARGS}
              value={spec.arguments}
              onChange={(e) => patch({ arguments: e.target.value })}
            />
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">端口映射</h3>
            {spec.ports.map((port, index) => (
              <div className="wsld__run-row" key={index}>
                <input
                  className="input"
                  data-test={`编排-绑定IP-${index + 1}`}
                  aria-label="绑定 IP"
                  placeholder="127.0.0.1"
                  value={port.hostIp}
                  onChange={(e) => setList('ports', index, { hostIp: e.target.value })}
                />
                <input
                  className="input"
                  data-test={`编排-主机端口-${index + 1}`}
                  aria-label="主机端口"
                  placeholder={PH_PORT}
                  value={port.hostPort}
                  onChange={(e) => setList('ports', index, { hostPort: e.target.value })}
                />
                <span className="wsld__field">→</span>
                <input
                  className="input"
                  data-test={`编排-容器端口-${index + 1}`}
                  aria-label="容器端口"
                  placeholder="80"
                  value={port.containerPort}
                  onChange={(e) => setList('ports', index, { containerPort: e.target.value })}
                />
                <select
                  className="select"
                  data-test={`编排-协议-${index + 1}`}
                  aria-label="协议"
                  value={port.protocol}
                  onChange={(e) => setList('ports', index, { protocol: e.target.value })}
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
                <IconButton
                  icon="remove"
                  label="删除这一行"
                  testId={`编排-删端口-${index + 1}`}
                  onClick={() => dropList('ports', index)}
                />
              </div>
            ))}
            <button type="button" className="btn" data-test="编排-加端口" onClick={() => addList('ports')}>
              添加端口
            </button>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">文件系统</h3>
            {spec.volumes.map((volume, index) => (
              <div className="wsld__run-row" key={index}>
                <input
                  className="input"
                  data-test={`编排-挂载来源-${index + 1}`}
                  aria-label="来源（主机路径或卷名）"
                  placeholder="来源：主机路径或卷名"
                  value={volume.source}
                  onChange={(e) => setList('volumes', index, { source: e.target.value })}
                />
                <span className="wsld__field">→</span>
                <input
                  className="input"
                  data-test={`编排-挂载目标-${index + 1}`}
                  aria-label="容器内路径"
                  placeholder="/app"
                  value={volume.target}
                  onChange={(e) => setList('volumes', index, { target: e.target.value })}
                />
                <label className="wsld__check">
                  <input
                    type="checkbox"
                    data-test={`编排-只读-${index + 1}`}
                    aria-label="只读"
                    checked={volume.readOnly}
                    onChange={(e) => setList('volumes', index, { readOnly: e.target.checked })}
                  />
                  <span>只读</span>
                </label>
                <IconButton
                  icon="remove"
                  label="删除这一行"
                  testId={`编排-删挂载-${index + 1}`}
                  onClick={() => dropList('volumes', index)}
                />
              </div>
            ))}
            <button type="button" className="btn" data-test="编排-加挂载" onClick={() => addList('volumes')}>
              添加挂载
            </button>
            {spec.tmpfsPaths.map((tmpfs, index) => (
              <div className="wsld__run-row" key={`t${index}`}>
                <input
                  className="input"
                  data-test={`编排-tmpfs-${index + 1}`}
                  aria-label="tmpfs 路径"
                  placeholder="tmpfs 路径，例如 /tmp"
                  value={tmpfs.path}
                  onChange={(e) => setList('tmpfsPaths', index, { path: e.target.value })}
                />
                <IconButton
                  icon="remove"
                  label="删除这一行"
                  testId={`编排-删tmpfs-${index + 1}`}
                  onClick={() => dropList('tmpfsPaths', index)}
                />
              </div>
            ))}
            <button type="button" className="btn" data-test="编排-加tmpfs" onClick={() => addList('tmpfsPaths')}>
              添加 tmpfs
            </button>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">环境与标签</h3>
            {spec.envVars.map((env, index) => (
              <div className="wsld__run-row" key={index}>
                <input
                  className="input"
                  data-test={`编排-变量名-${index + 1}`}
                  aria-label="变量名"
                  placeholder="变量名"
                  value={env.key}
                  onChange={(e) => setList('envVars', index, { key: e.target.value })}
                />
                <span className="wsld__field">=</span>
                <input
                  className="input"
                  data-test={`编排-变量值-${index + 1}`}
                  aria-label="变量值"
                  placeholder="值"
                  value={env.value}
                  onChange={(e) => setList('envVars', index, { value: e.target.value })}
                />
                <IconButton
                  icon="remove"
                  label="删除这一行"
                  testId={`编排-删变量-${index + 1}`}
                  onClick={() => dropList('envVars', index)}
                />
              </div>
            ))}
            <button type="button" className="btn" data-test="编排-加变量" onClick={() => addList('envVars')}>
              添加环境变量
            </button>
            <label className="wsld__run-field">
              <span className="wsld__field">变量文件 (--env-file)</span>
              <input
                className="input"
                data-test="编排-变量文件"
                aria-label="变量文件 (--env-file)"
                value={spec.envFile}
                onChange={(e) => patch({ envFile: e.target.value })}
              />
            </label>
            {spec.labels.map((label, index) => (
              <div className="wsld__run-row" key={index}>
                <input
                  className="input"
                  data-test={`编排-标签键-${index + 1}`}
                  aria-label="标签键"
                  placeholder="标签键"
                  value={label.key}
                  onChange={(e) => setList('labels', index, { key: e.target.value })}
                />
                <span className="wsld__field">=</span>
                <input
                  className="input"
                  data-test={`编排-标签值-${index + 1}`}
                  aria-label="标签值"
                  placeholder="值"
                  value={label.value}
                  onChange={(e) => setList('labels', index, { value: e.target.value })}
                />
                <IconButton
                  icon="remove"
                  label="删除这一行"
                  testId={`编排-删标签-${index + 1}`}
                  onClick={() => dropList('labels', index)}
                />
              </div>
            ))}
            <button type="button" className="btn" data-test="编排-加标签" onClick={() => addList('labels')}>
              添加标签
            </button>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">资源与网络</h3>
            <div className="wsld__run-grid">
              <label className="wsld__run-field">
                <span className="wsld__field">CPU 数 (--cpus)</span>
                <input className="input" data-test="编排-CPU数" aria-label="CPU 数 (--cpus)" value={spec.cpus} onChange={(e) => patch({ cpus: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">内存上限 (-m)</span>
                <input className="input" data-test="编排-内存" aria-label="内存上限 (-m)" placeholder="512m" value={spec.memory} onChange={(e) => patch({ memory: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">共享内存 (--shm-size)</span>
                <input className="input" data-test="编排-共享内存" aria-label="共享内存 (--shm-size)" placeholder="64m" value={spec.shmSize} onChange={(e) => patch({ shmSize: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">主机名 (-h)</span>
                <input className="input" data-test="编排-主机名" aria-label="主机名 (-h)" value={spec.hostname} onChange={(e) => patch({ hostname: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">网络 (--network)</span>
                <input className="input" data-test="编排-网络" aria-label="网络 (--network)" placeholder="host" value={spec.network} onChange={(e) => patch({ network: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">用户 (-u)</span>
                <input className="input" data-test="编排-用户" aria-label="用户 (-u)" placeholder="1000:1000" value={spec.user} onChange={(e) => patch({ user: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">工作目录 (-w)</span>
                <input className="input" data-test="编排-工作目录" aria-label="工作目录 (-w)" placeholder="/app" value={spec.workdir} onChange={(e) => patch({ workdir: e.target.value })} />
              </label>
            </div>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">健康检查</h3>
            <label className="wsld__run-field">
              <span className="wsld__field">检查命令 (--health-cmd)</span>
              <input
                className="input"
                data-test="编排-健康命令"
                aria-label="检查命令 (--health-cmd)"
                placeholder="curl -f localhost"
                value={spec.healthCmd}
                onChange={(e) => patch({ healthCmd: e.target.value })}
              />
            </label>
            <div className="wsld__run-grid">
              <label className="wsld__run-field">
                <span className="wsld__field">间隔</span>
                <input className="input" data-test="编排-健康间隔" aria-label="健康检查间隔" placeholder="30s" value={spec.healthInterval} onChange={(e) => patch({ healthInterval: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">超时</span>
                <input className="input" data-test="编排-健康超时" aria-label="健康检查超时" placeholder="5s" value={spec.healthTimeout} onChange={(e) => patch({ healthTimeout: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">重试次数</span>
                <input className="input" data-test="编排-健康重试" aria-label="健康检查重试次数" placeholder="3" value={spec.healthRetries} onChange={(e) => patch({ healthRetries: e.target.value })} />
              </label>
              <label className="wsld__run-field">
                <span className="wsld__field">启动宽限</span>
                <input className="input" data-test="编排-健康宽限" aria-label="健康检查启动宽限" placeholder="10s" value={spec.healthStartPeriod} onChange={(e) => patch({ healthStartPeriod: e.target.value })} />
              </label>
            </div>
            <label className="wsld__check">
              <input
                type="checkbox"
                data-test="编排-禁用健康检查"
                aria-label="禁用镜像自带的健康检查"
                checked={spec.noHealthcheck}
                onChange={(e) => patch({ noHealthcheck: e.target.checked })}
              />
              <span>禁用镜像自带的健康检查</span>
            </label>
          </section>

          <section className="wsld__run-sec">
            <h3 className="wsld__run-h">其他参数（原样追加）</h3>
            <textarea
              className="input wsld__run-area"
              data-test="编排-其他参数"
              aria-label="其他参数（原样追加）"
              rows={2}
              placeholder={PH_EXTRA}
              value={spec.extraArgs}
              onChange={(e) => patch({ extraArgs: e.target.value })}
            />
          </section>
        </div>

        <div className="wsld__run-side">
          <div className="wsld__run-cmd card">
            <h3 className="wsld__run-h">生成命令</h3>
            <pre className="wsld__run-text mono selectable" data-test="编排-命令">
              {command}
            </pre>
            <div className="wsld__run-btns row--wrap">
              <button type="button" className="btn" data-test="编排-复制" title={TIP_COPY} disabled={!canRun} onClick={() => void copy()}>
                复制
              </button>
              <button type="button" className="btn" data-test="编排-粘贴读回" title={TIP_IMPORT} disabled={busy} onClick={() => void importFromClipboard()}>
                粘贴并编辑
              </button>
              <button type="button" className="btn btn--primary" data-test="编排-执行" disabled={busy || !canRun} onClick={execute}>
                就地执行
              </button>
              {busy && (
                <button type="button" className="btn btn--danger" data-test="编排-终止" title={TIP_KILL} onClick={kill}>
                  终止
                </button>
              )}
              <button type="button" className="btn" data-test="编排-清空" title={TIP_CLEAR} disabled={busy} onClick={clearAll}>
                清空
              </button>
              {busy && (
                <span className="hint">
                  {RUNNING}
                  <span className="spinner" />
                </span>
              )}
            </div>
          </div>

          {issues.length > 0 && (
            <div className="wsld__run-issues" data-test="编排-问题">
              <div className="wsld__run-issues-head">{ISSUES_HEAD}</div>
              {issues.map((issue, index) => (
                <div className="wsld__run-issue" key={index}>
                  {describeRunIssue(issue)}
                </div>
              ))}
            </div>
          )}

          {error.length > 0 && <div className="wsld__bar wsld__bar--error error" data-test="编排-错误">{error}</div>}
          {notice.length > 0 && <div className="wsld__bar wsld__bar--ok" data-test="编排-提示">{notice}</div>}

          <div className="wsld__run-out">
            <h3 className="wsld__run-h">执行输出</h3>
            <pre ref={box} className="wsld__logs wsld__run-pre mono selectable" data-test="编排-输出">
              {executed ? output.join('\n') : OUT_EMPTY}
            </pre>
          </div>

          <div className="wsld__run-history">
            <h3 className="wsld__run-h">执行历史</h3>
            {history.length === 0 && <div className="hint wsld__empty" data-test="编排-历史空">{HISTORY_EMPTY}</div>}
            <div className="wsld__run-hlist">
              {history.map((entry, index) => (
                <div className="wsld__run-hrow" key={`${entry.timeText}-${index}`}>
                  <span className="wsld__run-htime hint">{entry.timeText}</span>
                  <span className="wsld__run-hcmd mono">{entry.command}</span>
                  <IconButton
                    icon="restart"
                    label={TIP_RESTORE}
                    testId={`编排-恢复-${index + 1}`}
                    onClick={() => restore(entry)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
