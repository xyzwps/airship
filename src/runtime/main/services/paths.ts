import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathEscape, type AppId } from '@airship/contract'

/**
 * 目录布局（全在用户主目录下的 `~/.airship`，安装落点见 PK-032/PK-035）：
 *
 *   ~/.airship/
 *     runtime/                       runtime 自己的落点（安装器钉，代码里没有真源）
 *     apps/<appId>/                  应用的落点（安装器钉：归档 + icon.ico + 卸载器）
 *     data/<appId>/                  应用私有数据——这一层**就是**数据目录，不再嵌一层 data/
 *       settings.json                应用私有设置（含它自己的主题档）
 *       cache/                       可随时整体删除重建（应用往数据目录写同名 `cache` 会被连累）
 *       backend/backend.cjs          后端影子（backendHost）
 *     logs/airship-YYYY-MM-DD.log
 *     icons/<id>.ico                 交给 Windows 外壳的任务栏图标（包内那份 icon.ico 的落盘）
 *     profile/                       Electron 自己的浏览器档（userData）：Chromium 缓存与渲染侧存储
 *
 * 家目录可以整份换掉：dev 由 CLI 给 `AIRSHIP_HOME` 指到项目里的 `.airship-dev/<id>`，
 * 截图模式（AIRSHIP_SHOT=1）换到 `~/.airship-shot`——工装与开发都不该踩在日常那一份上，
 * 也不跟日常实例抢同一份浏览器档。
 *
 * **每个应用的目录是按 id 现算的，不是启动时的一张快照。**
 * 这条是踩过来的：原来 `build()` 会遍历当时的注册表建一张 `apps` 表并缓存，
 * 于是拖放装进来的应用——注册表重扫了、这张表没重扫——第一次读写自己的数据就撞在
 * `Cannot read properties of undefined (reading 'data')` 上：格子里看得见、点得开，
 * 一开机就读失败。目录布局只依赖家目录与 id，本来就不需要知道"现在有哪些应用"。
 * 顺带也断了 `paths → appRegistry → logging → paths` 这个环。
 */

interface AppDirs {
  data: string
  cache: string
  settings: string
}

let cached: { root: string; logs: string } | null = null

/** 这台机器上 airship 的家：`AIRSHIP_HOME` 指哪就是哪，否则 `~/.airship`（截图模式是 `~/.airship-shot`） */
export function airshipHome(): string {
  const override = process.env.AIRSHIP_HOME
  if (override) return resolve(override)
  const shot = process.env.AIRSHIP_SHOT === '1'
  return join(app.getPath('home'), shot ? '.airship-shot' : '.airship')
}

/** Electron 自己的浏览器档所在区（主进程开局把 userData 钉到这里，见 main/index.ts） */
export function profileDir(): string {
  return join(airshipHome(), 'profile')
}

function build() {
  const root = airshipHome()
  const logs = join(root, 'logs')
  mkdirSync(logs, { recursive: true })
  return { root, logs }
}

export function paths() {
  if (!cached) cached = build()
  return cached
}

/**
 * 这个应用的那一族的根：`~/.airship/data/<id>`——它**就是**应用的数据目录，里面直接放数据文件，
 * 同层还有 cache、settings.json 与 backend。
 *
 * 与下面 `dirsFor` 的区别是**它不建目录**：卸载要问的是"这一族在不在"，
 * 不是"给我用一下"——用 appDataDir 去问会顺手把目录造出来，
 * 于是"没开过窗口的应用"被卸成"删过数据的应用"，界面上那句就念错了。
 */
export function appBaseDir(id: AppId): string {
  return join(paths().root, 'data', id)
}

/** 这个应用的三样；数据目录与缓存目录不存在就地建。所以"什么时候装的包"不影响它能不能用 */
function dirsFor(id: AppId): AppDirs {
  const data = appBaseDir(id)
  const cache = join(data, 'cache')
  mkdirSync(data, { recursive: true })
  mkdirSync(cache, { recursive: true })
  return { data, cache, settings: join(data, 'settings.json') }
}

export function appDataDir(id: AppId): string {
  return dirsFor(id).data
}

export function appCacheDir(id: AppId): string {
  return dirsFor(id).cache
}

export function appSettingsFile(id: AppId): string {
  return dirsFor(id).settings
}

export function logDir(): string {
  return paths().logs
}

/**
 * 外壳（任务栏按钮）用的那张图落在哪里：`~/.airship/icons/<id>.ico`。
 *
 * 为什么要在磁盘上另放一份：Windows 外壳读图标只认文件系统路径，既不认 asar，
 * 也不认 `airship://`——包根那份 `icon.ico`（PK-036，随源图一起备好的那一份）必须由 runtime 摊平了交出去。
 * 这份是**包内那份的落盘副本**，不是应用数据：重装或重产包后按包内字节覆盖，删了也只是回落成 runtime 的样子。
 */
export function taskbarIconFile(id: AppId): string {
  const dir = join(paths().root, 'icons')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${id}.ico`)
}

/** 把若干段拼到应用数据目录下，并挡住 ../ 越界 */
export function resolveInData(id: AppId, segments: string[]): string {
  return resolveUnder(appDataDir(id), segments, `${id} 的数据目录`)
}

function resolveUnder(base: string, segments: string[], label: string): string {
  const target = join(base, ...segments)
  if (!isInside(base, target)) {
    throw new Error(pathEscape(segments, label))
  }
  return target
}

export function isInside(base: string, target: string): boolean {
  const b = normalize(base)
  const t = normalize(target)
  return t === b || t.startsWith(b.endsWith('\\') ? b : b + '\\')
}

/** Windows 上大小写不敏感，统一小写比较；同时把 / 归一成 \ */
function normalize(p: string): string {
  const s = p.replace(/\//g, '\\')
  return process.platform === 'win32' ? s.toLowerCase() : s
}
