import type { PlatformId } from './protocol.ts'
import type { AppMeta } from './app.ts'

/**
 * 契约层拒绝原因的**唯一措辞来源**。
 *
 * 这些句子是要给用户看的（错误条上、日志里），册子里也按原文钉住它们
 * （src/runtime/specs/bridge.md）。所以主进程与测试替身必须共用一份：
 * 各写各的，就会出现"测试绿着但真实界面念的是另一句"。
 */

/** 读未授权路径 */
export const readDenied = (path: string): string =>
  `没有读取权限：${path}（只能读应用数据目录，或先用文件对话框选中它）`

/** 写未授权路径 */
export const writeDenied = (path: string): string =>
  `没有写入权限：${path}（只能写应用数据目录，或用另存为对话框选定目标）`

/** 拼路径越界 */
export const pathEscape = (segments: readonly string[], label: string): string =>
  `路径越界：${segments.join('/')} 不在${label}内`

/** 身份与窗口归属不符 */
export const identityMismatch = (owner: string, claimed: string): string =>
  `身份不匹配：这个窗口属于 ${owner}，不能以 ${claimed} 的名义调用`

/** 调用来源不是 runtime 登记的窗口 */
export const unknownSender = (): string => '调用来源不是 runtime 注册的窗口，拒绝'

/** 设置作用域参数不合法 */
export const needScopeString = (): string => '设置作用域必须是字符串'

/** 应用 id 不在清单里 */
export const unknownApp = (id: string): string => `未知的应用 id：${id}`

/** 这个 id 没有注册，runtime 不认识它 */
export const notRegistered = (id: string): string => `没有注册这个应用：${id}`

/**
 * id 不合 APP_ID_PATTERN（src/shared/app.ts）。
 * 产包器 code/pack-app.mjs 里有同一句话的一份，两份由 src/apps/tests/package.test.ts 钉相等。
 */
export const badAppId = (id: string): string =>
  `id "${id}" 不合形状：只能是 1 到 32 位，小写字母开头，其后只用小写字母、数字与连字符` +
  `（id 同时是包目录名、数据目录名与 airship:// 地址里的一段，这几处对字符都有硬性要求；` +
  `界面显示名写在 name 字段，那里不限字符）`

/** 该应用在当前平台上不可用（清单 platforms 字段声明过） */
export const platformUnsupported = (name: string, reason: string): string =>
  `${name} 在这台机器上用不了：${reason}`

/* ---------------- 直跑一个包的措辞 ---------------- */

/** 没带任何包路径启动：念用法，不开任何界面 */
export const usageLine = (): string =>
  'airship runtime 不自己开界面：把一个包的路径交给它（airship.exe <id>.airship），' +
  '或装一个应用后用它的快捷方式。'

/** 同一个 id 已经开着另一份归档：不顶替，念清两份各在哪 */
export const sameIdDifferentArchive = (id: string, active: string, incoming: string): string =>
  `同一个 id 已经跑着另一份包：${id} 现在用的是 ${active}，这次交来的是 ${incoming}。` +
  '先关掉它的窗口再跑这一份。'

/* ---------------- 应用安装器的措辞（产安装器时烘进 NSIS 脚本，单一真源） ---------------- */

/** 安装器找不到 runtime：念清装哪、怎么指，然后中止，一个文件都不写 */
export const runtimeNotFound = (): string =>
  '找不到 airship runtime：先装 runtime（固定装在 %USERPROFILE%\\.airship\\runtime），' +
  '或把 AIRSHIP_PATH 指到它所在的目录。'

/* ---------------- 装包失败的措辞（应用安装器与直跑共用） ---------------- */

/** 归档不合格：原因逐条列出来，一条都不抹 */
export const packageRejected = (name: string, reasons: readonly string[]): string =>
  `这个包跑不起来：${name}\n${reasons.map((r) => '  · ' + r).join('\n')}`

/** 参数必须是非空字符串 */
export const needString = (label: string, got: unknown): string =>
  `${label} 必须是非空字符串，收到 ${JSON.stringify(got)}`

/** 桥没拿到结果 */
export const noResult = (channel: string): string => `${channel} 调用失败（主进程没有返回结果）`

/** preload 没加载 */
export const noBridge = (): string =>
  'window.airship 不存在：preload 没有加载成功。' +
  '检查 electron.vite.config.ts 的 preload 入口和窗口的 webPreferences.preload 路径。'

/* ---------------- 后台程序的措辞（包根 backend.js 约定 ↔ api.backend） ---------------- */

/** 包里没有 backend.js 却调了 api.backend：念约定 */
export const backendAbsent = (app: string): string =>
  `${app} 没有自带后台程序：包根要有 backend.js——源项目里放一个 src/backend.ts 或 src/backend.js，产包就会带上`

/** 注册时验过条目在包里；运行期读不到只剩一种解释——包被换掉或损坏 */
export const backendEntryUnreadable = (app: string, entry: string): string =>
  `${app} 读不出后端入口 ${entry}：那份归档可能已被替换或损坏，重新装一次这个应用`

/** 后台进程在回话之前退出（崩溃或被杀） */
export const backendExited = (method: string): string =>
  `后端程序中途退出，没等到 ${method} 的回话（下一次调用会再拉起一个新的）`

/** 后台程序没在时限内报就绪 */
export const backendNotReady = (app: string, seconds: number): string =>
  `${app} 的后端程序没在 ${seconds} 秒内报就绪：后端入口启动后要最先给 runtime 发一条 { ready: true }`

/** 一次调用超时（进程活着，这条不回） */
export const backendNoAnswer = (method: string, seconds: number): string =>
  `后端程序没在 ${seconds} 秒内回话：${method}（调用取消了，后端进程还留着——它要是之后回了话会被丢弃）`

/** 外部链接协议 */
export const linkDenied = (url: string): string => `只允许打开 http/https 链接：${url}`

/**
 * 校验一份清单的 platforms 声明：在当前平台上不能用就说清原因，能用则 null。
 * 纯函数——主进程注册与开窗口、测试替身都问它同一个问题，
 * 免得同一份 platforms 声明在不同入口念出两套拒绝话。
 */
export function platformIssue(meta: Pick<AppMeta, 'name' | 'platforms'>, current: PlatformId | 'unknown'): string | null {
  const wanted = meta.platforms
  if (!wanted || wanted.length === 0) return null
  if ((wanted as string[]).includes(current)) return null
  return `它只在 ${wanted.join(' / ')} 上可用，这台机器是 ${current}`
}
