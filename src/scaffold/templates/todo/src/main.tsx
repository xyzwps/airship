import { createAirshipApp } from '@airship/sdk'
import { app } from './app.ts'
import App from './App.tsx'

/**
 * 包的入口脚本：把清单与组件交给 SDK 宿主，宿主画出标题栏、落主题、留白边。
 *
 * `icon` 是包根那张源图的相对路径。应用侧除了这一行不需要知道 runtime 的存在——
 * 这就是"包自持"的意思。
 */
createAirshipApp({ meta: app, component: App, icon: './icon.svg' })
