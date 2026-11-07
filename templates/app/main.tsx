import { createAirshipApp } from '@airship/sdk'
import { app } from './app.ts'
import ChangeMeApp from './CHANGE_MEApp.tsx'

/**
 * 包的入口脚本：把清单与组件交给 SDK 宿主，宿主画出标题栏、落主题、按 flush 给不留白。
 *
 * `icon` 是包根那张图标的相对路径——图标是文件约定，清单里没有图标字段（AP-007）。
 * 应用侧除了这一行不需要知道壳的存在：这就是"包自持"的意思。
 */
createAirshipApp({ meta: app, component: ChangeMeApp, icon: './icon.svg' })
