import { createAirshipApp } from '@airship/sdk'
import { app } from './app'
import BooksApp from './BooksApp'

createAirshipApp({ meta: app, component: BooksApp, icon: './icon.png' })
