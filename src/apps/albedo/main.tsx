import { createAirshipApp } from '@airship/sdk'
import { app } from './app.ts'
import AlbedoApp from './AlbedoApp.tsx'

/**
 * 包的入口脚本：把清单与组件交给 SDK 宿主，宿主画出标题栏、落主题。
 *
 * Albedo 用 `flush`：版心是自己的三栏工作台（插入栏 / 舞台 / 检查器），
 * 内边距会把舞台的拖放热区切掉一圈。
 */
createAirshipApp({ meta: app, component: AlbedoApp, icon: './icon.svg' })
