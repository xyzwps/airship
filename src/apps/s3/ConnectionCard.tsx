import { useState, type JSX } from 'react'
import { DEFAULT_ENDPOINT, DEFAULT_REGION, type Source, type SourceInput } from './connection.ts'

/**
 * 连接卡：一个源的五个格子。
 *
 * 标签在左、输入在同一行，五行共用一个星号列——这是这个仓库里表单的唯一排法，
 * 不写死宽度（中文标签三个字与"Access Key"六个字各占多少本来就不该由代码定）。
 *
 * 新增与编辑走同一张卡：带着 `current` 就是编辑那一个源（名字可以改），不给就是新增。
 * 重名由应用层判（它才知道列表里已有谁），卡片只管这五个格子。
 *
 * 密钥存进设置这件事要在界面上说出来：这一档是明文落盘的，
 * 卡片底下那一句就是它的说明书，不藏进文档里。
 */
export function ConnectionCard({
  current,
  error,
  busy,
  onCancel,
  onRemove,
  onSubmit
}: {
  current: Source | null
  error: string
  busy: boolean
  onCancel?: () => void
  /** 只有编辑一个已有的源时才有：删掉它就在这张卡里，改哪个删哪个 */
  onRemove?: () => void
  onSubmit: (input: SourceInput) => void
}): JSX.Element {
  const [name, setName] = useState(current?.name ?? '')
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? DEFAULT_ENDPOINT)
  const [region, setRegion] = useState(current?.region ?? DEFAULT_REGION)
  const [accessKeyId, setAccessKeyId] = useState(current?.accessKeyId ?? '')
  const [secretAccessKey, setSecretAccessKey] = useState(current?.secretAccessKey ?? '')

  const submit = (): void => onSubmit({ name, endpoint, region, accessKeyId, secretAccessKey })

  return (
    <div className="s3__card">
      <div className="s3__field">
        <label htmlFor="s3-name">名字</label>
        <input
          className="input"
          id="s3-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="家里的 RustFS"
        />
      </div>
      <div className="s3__field">
        <label htmlFor="s3-endpoint">端点</label>
        <input
          className="input"
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
          className="input"
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
          className="input"
          id="s3-ak"
          value={accessKeyId}
          onChange={(e) => setAccessKeyId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      <div className="s3__field">
        <label htmlFor="s3-sk">Secret Key</label>
        <input
          className="input"
          id="s3-sk"
          type="password"
          value={secretAccessKey}
          onChange={(e) => setSecretAccessKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
      </div>
      {error !== '' ? <p className="s3__error s3__card-error">{error}</p> : null}
      <div className="s3__card-foot">
        <span className="s3__note">五个格子都存进本机设置，Secret Key 是明文。</span>
        <button type="button" className="btn btn--primary" disabled={busy} onClick={submit}>
          {current ? '存下' : '连上'}
        </button>
        {onRemove ? (
          <button type="button" className="btn btn--ghost btn--danger" data-test="source-remove" onClick={onRemove}>
            删掉这个源
          </button>
        ) : null}
        {onCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            取消
          </button>
        ) : null}
      </div>
    </div>
  )
}
