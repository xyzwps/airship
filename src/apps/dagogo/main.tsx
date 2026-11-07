import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import DagogoApp from './DagogoApp'

createAirshipApp({ meta: app, component: DagogoApp, icon: './icon.svg' })
