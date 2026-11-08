import type { AppApi } from '@airship/contract'

/**
 * 一台机器上要连的每一个对象存储端点，以及它们的落盘形状。
 *
 * 一个**源** = 一个端点加它的钥匙，界面上给个名字（「家里的 RustFS」这种），
 * 因为一个人同时连着好几家是很常事——旧形状只存一份连接，装不下第二个。
 * 2026-11-08 换成列表，旧的那一份**不迁移**：设置里原来的 `connection` 键读到就忽略，
 * 第一次开这个版本要重新填一次（写一段兼容代码换一次输入框的形状，不值）。
 *
 * 只有 `name`、`endpoint` 与密钥是"用户填的"，`region` 是给签名用的：SigV4 必须有一个区域串，
 * 自建端点（RustFS、MinIO）不校验它，真 AWS 与阿里云则必填——所以它是界面上的一格。
 *
 * 桶一律走**路径风格**（`http://host/bucket/key`）：自建端点几乎都是这样，真 AWS 也收。
 * 虚拟主机风格（`bucket.host/key`）需要端点那边的 DNS 与证书配合，一个桌面客户端猜不了。
 */
export interface Source {
  /** 界面上念的那一个名字，同一份列表里不重复 */
  name: string
  /** 形如 http://localhost:9000 或 https://s3.us-west-2.amazonaws.com，不带尾斜杠 */
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** 设置里那两个键：整份源列表一处，当前用哪一个一处 */
export const SOURCES_KEY = 'sources'
export const CURRENT_KEY = 'currentSource'

/** 第一次打开（列表为空）时，界面上先给的那一行端点与区域 */
export const DEFAULT_ENDPOINT = 'http://localhost:9000'
export const DEFAULT_REGION = 'us-east-1'

/** 界面上那五个格子 */
export interface SourceInput {
  name: string
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * 把界面上那五个格子解成一个源，解不出来就给一句中文原因。
 *
 * 措辞是契约的一部分（册子 OS-002 钉的就是这几句），所以它在这里、不在组件里。
 * 刻意不做"帮你补一个 http://"或"去掉尾斜杠"之外的事：地址这种东西填错了要让人当场看见，
 * 静默改写的代价是下次换了端点再也猜不出连的是哪个。
 *
 * `taken` 是这份列表里**除自己以外**已有的名字：名字要认得出是谁，重了就说不清连的是哪家。
 */
export function parseSource(input: SourceInput, taken: string[] = []): { ok: true; source: Source } | { ok: false; reason: string } {
  const name = input.name.trim()
  if (name === '') return { ok: false, reason: '名字是空的（给这个源起一个认得出的名字）' }
  if (taken.includes(name)) return { ok: false, reason: `已经有叫「${name}」的源了，换个名字` }

  const raw = input.endpoint.trim()
  if (raw === '') return { ok: false, reason: '端点是空的' }
  // 先认协议头：`new URL('localhost:9000')` 会把 localhost 当协议名解过去，
  // 那句"只能是 http 或 https"就念得莫名其妙——缺协议头是最常见的一种填法，要当场说清
  if (!/^https?:\/\//i.test(raw)) return { ok: false, reason: `端点要以 http:// 或 https:// 开头，收到 ${raw}` }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `端点要写成完整地址，收到 ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `端点只能是 http 或 https，收到 ${url.protocol.replace(':', '')}` }
  }
  if (url.hostname === '') return { ok: false, reason: `端点里没有主机名，收到 ${raw}` }
  if (url.pathname.replace(/\/+$/, '') !== '') {
    return { ok: false, reason: `端点只写到主机与端口就行，收到 ${raw}` }
  }

  const accessKeyId = input.accessKeyId.trim()
  const secretAccessKey = input.secretAccessKey.trim()
  if (accessKeyId === '') return { ok: false, reason: 'Access Key 是空的' }
  if (secretAccessKey === '') return { ok: false, reason: 'Secret Key 是空的' }

  const region = input.region.trim()
  if (region === '') return { ok: false, reason: '区域是空的（自建端点不知道填什么就用 us-east-1）' }

  // 尾斜杠抹掉：SDK 拼地址时多一道斜杠会变成 //bucket/key，签名与路由都对不上
  const endpoint = `${url.protocol}//${url.host}`
  return { ok: true, source: { name, endpoint, region, accessKeyId, secretAccessKey } }
}

/** 列表里那一个格子的形状不成样子（旧数据、手改过的文件）就当没有它，不猜 */
function asSource(value: unknown): Source | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<SourceInput>
  const parsed = parseSource(
    {
      name: String(raw.name ?? ''),
      endpoint: String(raw.endpoint ?? ''),
      region: String(raw.region ?? ''),
      accessKeyId: String(raw.accessKeyId ?? ''),
      secretAccessKey: String(raw.secretAccessKey ?? '')
    },
    // 读盘这一趟不比名字：列表里真出现两个同名，界面上还是一起列出来，
    // 只是不因为"后面那个撞名"就把它整个丢掉
    []
  )
  return parsed.ok ? parsed.source : null
}

/** 从设置里读那份列表；没存过就是空表（界面上摊出连接卡） */
export async function loadSources(api: AppApi): Promise<Source[]> {
  const stored = await api.settings.get<unknown[]>(SOURCES_KEY, [])
  if (!Array.isArray(stored)) return []
  return stored.map(asSource).filter((s): s is Source => s !== null)
}

/** 当前用哪一个源的名字；列表里没有它就算没选 */
export async function loadCurrent(api: AppApi): Promise<string> {
  return await api.settings.get<string>(CURRENT_KEY, '')
}

export async function saveSources(api: AppApi, sources: Source[]): Promise<void> {
  await api.settings.set(SOURCES_KEY, sources satisfies Source[])
}

export async function saveCurrent(api: AppApi, name: string): Promise<void> {
  await api.settings.set(CURRENT_KEY, name)
}

/** 端点的主机与端口，界面上跟在名字后面念一句 */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}
