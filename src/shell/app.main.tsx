import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AppHost } from '../shell/AppHost'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在，检查 app.html')

/** 宿主由 URL 参数指定要装哪个应用；身份本身在 preload 的启动参数里 */
const appId = new URLSearchParams(window.location.search).get('app') ?? ''

createRoot(container).render(
  <StrictMode>
    <AppHost appId={appId} />
  </StrictMode>
)
