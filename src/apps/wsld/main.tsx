import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import WsldApp from './WsldApp'

createAirshipApp({ meta: app, component: WsldApp, icon: './icon.png' })
