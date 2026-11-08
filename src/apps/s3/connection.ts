import type { AppApi } from '@airship/contract'

/**
 * 连一个对象存储端点要的那几样，以及它们的落盘形状。
 *
 * 只有 `endpoint` 与密钥是"用户填的"，`region` 是给签名用的：SigV4 必须有一个区域串，
 * 自建端点（RustFS、MinIO）不校验它，真 AWS 与阿里云则必填——所以它是界面上的一格，
 * 默认 `us-east-1`，不藏进代码里。
 *
 * 桶一律走**路径风格**（`http://host/bucket/key`）：自建端点几乎都是这样，
 * 真 AWS 也收。虚拟主机风格（`bucket.host/key`）需要端点那边的 DNS 与证书配合，
 * 一个桌面客户端猜不了，所以这里不留那个开关。
 */
export interface Connection {
  /** 形如 http://localhost:9000 或 https://s3.us-west-2.amazonaws.com，不带尾斜杠 */
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** 设置里的那一键；整份连接存一处，改一处等于改整份 */
export const CONNECTION_KEY = 'connection'

/** 没填过任何一次时，界面上先给的那一行端点 */
export const DEFAULT_ENDPOINT = 'http://localhost:9000'
export const DEFAULT_REGION = 'us-east-1'

/** 界面上填的形状：三个必填 + 一个可空区域 */
export interface ConnectionInput {
  endpoint: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * 把界面上那四个格子解成一份连接，解不出来就给一句中文原因。
 *
 * 措辞是契约的一部分（册子 OS-002 钉的就是这几句），所以它在这里、不在组件里。
 * 刻意不做"帮你补一个 http://"或"去掉尾斜杠"之外的事：
 * 地址这种东西，填错了要让人当场看见，静默改写的代价是下次换了端点再也猜不出连的是哪个。
 */
export function parseConnection(input: ConnectionInput): { ok: true; conn: Connection } | { ok: false; reason: string } {
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
  return { ok: true, conn: { endpoint, region, accessKeyId, secretAccessKey } }
}

/** 从设置里读那份连接；没存过、或存的东西不成形状，都算"还没配" */
export async function loadConnection(api: AppApi): Promise<Connection | null> {
  const stored = await api.settings.get<Partial<ConnectionInput> | null>(CONNECTION_KEY, null)
  if (!stored) return null
  const parsed = parseConnection({
    endpoint: String(stored.endpoint ?? ''),
    region: String(stored.region ?? ''),
    accessKeyId: String(stored.accessKeyId ?? ''),
    secretAccessKey: String(stored.secretAccessKey ?? '')
  })
  return parsed.ok ? parsed.conn : null
}

/** 存这一份连接，界面上那四个格子下次开就回填它 */
export async function saveConnection(api: AppApi, conn: Connection): Promise<void> {
  await api.settings.set(CONNECTION_KEY, {
    endpoint: conn.endpoint,
    region: conn.region,
    accessKeyId: conn.accessKeyId,
    secretAccessKey: conn.secretAccessKey
  } satisfies Connection)
}
