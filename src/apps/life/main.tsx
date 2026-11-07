import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import LifeApp from './LifeApp'

createAirshipApp({ meta: app, component: LifeApp, icon: './icon.svg' })
