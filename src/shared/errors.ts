import { TOOL_NAMES } from './protocol'
import type { PlatformId } from './protocol'
import type { AppMeta } from './app'

/**
 * 契约层拒绝原因的**唯一措辞来源**。
 *
 * 这些句子是要给用户看的（错误条上、日志里），册子里也按原文钉住它们
 * （docs/specs/bridge.md）。所以主进程与测试替身必须共用一份：
 * 各写各的，就会出现"测试绿着但真实界面念的是另一句"。
 */

/** 能力未声明 */
export const capDenied = (app: string, cap: string): string =>
  `${app} 没有声明 ${cap} 能力（要用它就在 apps/${app}/app.ts 的 capabilities 里声明）`

/** 读未授权路径 */
export const readDenied = (path: string): string =>
  `没有读取权限：${path}（只能读应用数据目录，或先用文件对话框选中它）`

/** 写未授权路径 */
export const writeDenied = (path: string): string =>
  `没有写入权限：${path}（只能写应用数据目录，或用另存为对话框选定目标）`

/** 共享命名空间未声明 */
export const nsDenied = (app: string, ns: string): string =>
  `${app} 没有声明共享命名空间 ${ns}（在 apps/${app}/app.ts 的 sharedNamespaces 里声明）`

/** 拼路径越界 */
export const pathEscape = (segments: readonly string[], label: string): string =>
  `路径越界：${segments.join('/')} 不在${label}内`

/** 身份与窗口归属不符 */
export const identityMismatch = (owner: string, claimed: string): string =>
  `身份不匹配：这个窗口属于 ${owner}，不能以 ${claimed} 的名义调用`

/** 应用专用接口被启动器调了 */
export const appChannelOnly = (): string => '这个接口只给应用用，启动器不该调'

/** 启动器专用接口被应用调了 */
export const shellChannelOnly = (): string => '这个接口只有启动器能用'

/** 调用来源不是壳登记的窗口 */
export const unknownSender = (): string => '调用来源不是壳注册的窗口，拒绝'

/** 应用想读写壳级设置作用域 */
export const shellScopeOnly = (): string => '只有启动器能读写壳级设置'

/** 设置作用域参数不合法 */
export const needScopeString = (): string => '设置作用域必须是字符串'

/** 应用 id 不在清单里 */
export const unknownApp = (id: string): string => `未知的应用 id：${id}`

/** 这个 id 没有清单，壳不认识它 */
export const notRegistered = (id: string): string => `没有注册这个应用：${id}`

/** 该应用在当前平台上不可用（清单 platforms 字段声明过） */
export const platformUnsupported = (name: string, reason: string): string =>
  `${name} 在这台机器上用不了：${reason}`

/** 子进程白名单外的可执行文件 */
export const exeDenied = (exe: string): string =>
  `不允许执行 ${exe}：可执行文件必须先由壳发现或用户在设置里指定（见 tools.ts 的白名单规则）`

/** 同一应用内任务标识重复 */
export const dupJob = (jobId: string): string =>
  `任务标识重复：${jobId}（同一个应用内要唯一）`

/** 参数必须是非空字符串 */
export const needString = (label: string, got: unknown): string =>
  `${label} 必须是非空字符串，收到 ${JSON.stringify(got)}`

/** 桥没拿到结果 */
export const noResult = (channel: string): string => `${channel} 调用失败（主进程没有返回结果）`

/** preload 没加载 */
export const noBridge = (): string =>
  'window.airship 不存在：preload 没有加载成功。' +
  '检查 electron.vite.config.ts 的 preload 入口和窗口的 webPreferences.preload 路径。'

/** 工具指定文件校验不过 */
export const toolNotVerified = (tool: string, out: string): string =>
  `${tool} 的 -version 输出里没有认得的版本字样，可能不是 ${tool}。输出开头：${out.slice(0, 200)}`

/** 想用的工具没在自己清单里声明 */
export const toolDenied = (app: string, tool: string): string =>
  `${app} 没有声明 ${tool} 工具（要用它就在 apps/${app}/app.ts 的 tools 里声明）`

/** 清单里写了壳不认识的运行期工具 */
export const unknownTool = (app: string, tool: string): string =>
  `${app} 的清单声明了壳不认识的工具 ${tool}（壳只认 ${TOOL_NAMES.join(' / ')}）`

/** 调用时传了壳不认识的工具名 */
export const badToolName = (tool: string): string =>
  `壳不认识的工具：${tool}（壳的工具表只有 ${TOOL_NAMES.join(' / ')}）`

/** 外部链接协议 */
export const linkDenied = (url: string): string => `只允许打开 http/https 链接：${url}`

/**
 * 校验一份清单的 platforms 声明：在当前平台上不能用就说清原因，能用则 null。
 * 纯函数——主进程开窗口、启动器画格子、测试替身都问它同一个问题，
 * 免得"格子里没有"和"点开被拒"念出两套话。
 */
export function platformIssue(meta: Pick<AppMeta, 'name' | 'platforms'>, current: PlatformId | 'unknown'): string | null {
  const wanted = meta.platforms
  if (!wanted || wanted.length === 0) return null
  if ((wanted as string[]).includes(current)) return null
  return `它只在 ${wanted.join(' / ')} 上可用，这台机器是 ${current}`
}
