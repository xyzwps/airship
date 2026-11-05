import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Launcher } from '../shell/Launcher'
import './styles.css'

const container = document.getElementById('root')
if (!container) throw new Error('#root 不存在，检查 launcher.html')

if (!window.airshipShell) {
  throw new Error('window.airshipShell 不存在：这个窗口没按启动器身份加载 preload')
}

createRoot(container).render(
  <StrictMode>
    <Launcher />
  </StrictMode>
)
