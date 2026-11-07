import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import PdfApp from './PdfApp'

createAirshipApp({ meta: app, component: PdfApp, icon: './icon.svg' })
