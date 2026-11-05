import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Shell } from './shell/Shell'
import { requireBridge } from './shell/bridge'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在，检查 index.html')

// preload 没接上就立刻炸，别让界面渲染出来之后所有调用都静默失败
requireBridge()

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>
)
