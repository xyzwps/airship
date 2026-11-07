import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import VcpApp from './VcpApp'

createAirshipApp({ meta: app, component: VcpApp, icon: './icon.svg' })
