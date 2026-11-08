import { useState, type JSX } from 'react'
import { DEFAULT_ENDPOINT, DEFAULT_REGION, type Connection, type ConnectionInput } from './connection.ts'

/**
 * 连接卡：端点、区域、Access Key、Secret Key 四个格子。
 *
 * 标签在左、输入在同一行，四行共用一个星号列——这是这个仓库里表单的唯一排法，
 * 不写死宽度（中文标签三个字与"Access Key"六个字各占多少本来就不该由代码定）。
 *
 * 密钥存进设置这件事要在界面上说出来：这一档是明文落盘的，
 * 卡片底下那一句就是它的说明书，不藏进文档里。
 */
export function ConnectionCard({
  current,
  error,
  busy,
  onCancel,
  onSubmit
}: {
  current: Connection | null
  error: string
  busy: boolean
  onCancel?: () => void
  onSubmit: (input: ConnectionInput) => void
}): JSX.Element {
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? DEFAULT_ENDPOINT)
  const [region, setRegion] = useState(current?.region ?? DEFAULT_REGION)
  const [accessKeyId, setAccessKeyId] = useState(current?.accessKeyId ?? '')
  const [secretAccessKey, setSecretAccessKey] = useState(current?.secretAccessKey ?? '')

  const submit = (): void => onSubmit({ endpoint, region, accessKeyId, secretAccessKey })

  return (
    <div className="s3__card">
      <div className="s3__field">
        <label htmlFor="s3-endpoint">端点</label>
        <input
          id="s3-endpoint"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="http://localhost:9000"
        />
      </div>
      <div className="s3__field">
        <label htmlFor="s3-region">区域</label>
        <input
          id="s3-region"
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="us-east-1"
        />
      </div>
      <div className="s3__field">
        <label htmlFor="s3-ak">Access Key</label>
        <input
          id="s3-ak"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="s3__field">
        <label htmlFor="s3-sk">Secret Key</label>
        <input
          id="s3-sk"
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      {error !== '' ? <p className="s3__error s3__card-error">{error}</p> : null}
      <div className="s3__card-foot">
        <span className="s3__note">四个格子都存进本机设置，Secret Key 是明文。</span>
        <button type="button" className="s3__go" disabled={busy} onClick={submit}>
          连上
        </button>
        {onCancel ? (
          <button type="button" className="s3__ghost" onClick={onCancel}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  )
}
