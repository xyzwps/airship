/**
 * 开发模式与直跑产物共用的那条流水线：定位应用目录 → 读清单 → vite 构建 → 装成包。
 *
 * dev 与 start 只在最后一步分岔：dev 额外起一个 vite dev server，并把入口文档的完整地址
 * （`AIRSHIP_DEV_URL`）交给 runtime——窗口加载的是 dev server 上那份源码（热更才有效），
 * 包只提供清单与图标这两件注册期要读的东西。这正是仓库里 `just dev` 的同一条路，
 * 对外部作者重新走一遍。
 *
 * 图标那一步与仓库内不同（PK-039）：产物目录里**自备** icon.ico，
 * 应用目录的源图与 icon.ico 都会被打进包——没有 Python/Pillow 的机器上照样产得出包，
 * 缺 icon.ico 就响亮失败，不放行一个"任务栏只能穿 runtime 图标"的包。
 */

import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { build, createServer } from 'vite'
import { WINDOWS_ICON_NAME } from '@airship/contract'
import { packPackage } from './pack.mjs'
import { findAppManifestFile, readAppManifest } from './manifest.mjs'

const ICON_SOURCE_PATTERN = /^icon\.(svg|png|jpe?g|webp)$/

/**
 * 找应用目录：单应用项目的两种摆法——`<项目>/src`（手脚架默认）与项目根直接放应用文件。
 * dev server 的 root 就是项目根：入口文档地址是 `<url>/src/index.html` 或 `<url>/index.html`，
 * 由 launcher 把完整文档 URL 交给 runtime——runtime 不认识任何目录形状。
 */
export function locateApp(projectRoot) {
  for (const dir of [join(projectRoot, 'src'), projectRoot]) {
    if (existsSync(join(dir, 'index.html')) && findAppManifestFile(dir)) {
      return { appDir: dir }
    }
  }
  throw new Error(
    `没找到应用：${projectRoot} 的 src/ 或项目根里要有 index.html 与 app.ts（或 app.mjs / app.js）`
  )
}

/** 一次构建：vite 用内联配置跑，不要求项目里有 vite.config */
async function buildApp(appDir, outDir) {
  const { default: react } = await import('@vitejs/plugin-react')
  const { airshipCspPlugin } = await import('@airship/sdk/vite')
  await build({
    configFile: false,
    root: appDir,
    base: './',
    logLevel: 'warn',
    resolve: {
      // 一个包内两份 react 会让 hooks 立刻炸
      dedupe: ['react', 'react-dom', 'react/jsx-runtime']
    },
    plugins: [react(), airshipCspPlugin()],
    build: {
      outDir,
      emptyOutDir: true,
      sourcemap: false,
      modulePreload: { polyfill: false }
    }
  })
}

/** 图标是文件约定，vite 不搬：源图与自备的 icon.ico 都拷进产物目录 */
function copyIcons(appDir, outDir) {
  for (const name of readdirSync(appDir)) {
    if (ICON_SOURCE_PATTERN.test(name) || name === WINDOWS_ICON_NAME) {
      cpSync(join(appDir, name), join(outDir, name))
    }
  }
}

/**
 * 后端入口不在前端的模块图里，vite 不会自己搬：把清单 `backend` 所在的那个目录整个拷进产物。
 * 整个目录而不是单文件——后台程序照例要 import 自己那族模块，PK-038 只认包里有没有那个路径。
 * 目录不存在就在这里默默不拷，让产包以「包里没有后端入口文件 …」那句原话炸——判据只有产包侧一份。
 */
function copyBackend(appDir, outDir, backend) {
  if (typeof backend !== 'string' || backend === '') return
  const dir = dirname(backend)
  if (dir === '' || dir === '.') {
    cpSync(join(appDir, backend), join(outDir, backend))
    return
  }
  const from = join(appDir, dir)
  if (existsSync(from)) cpSync(from, join(outDir, dir), { recursive: true })
}

/** 构建 + 装包。中间产物全在系统临时目录，只有包落在 packagesOut 里。 */
export async function buildAndPack({ projectRoot, id, packagesOut }) {
  const { appDir } = locateApp(projectRoot)
  const work = mkdtempSync(join(tmpdir(), 'airship-cli-'))
  try {
    const appTs = findAppManifestFile(appDir)
    const manifest = await readAppManifest({ appTs, workDir: work })
    if (manifest.id !== id) {
      throw new Error(`app.ts 的 id "${manifest.id}" 与 package.json 的 name "${id}" 不一致：id 只有一个真源，改齐再产包`)
    }
    const built = join(work, `built-${id}`)
    await buildApp(appDir, built)
    copyIcons(appDir, built)
    copyBackend(appDir, built, manifest.backend)
    const { file } = packPackage({ srcDir: built, outRoot: resolve(projectRoot, packagesOut), manifest })
    return { file, manifest }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 开发模式：构建装包（注册期读清单与图标）→ 起 vite dev server → 拉起装好的 runtime。
 * 窗口加载的是 dev server 那份源码，改一行刷新即见；runtime 用独立的 userData 目录，
 * 不与日常使用的应用抢单实例锁。
 */
export async function runDev({ projectRoot, id, port = 5177, packagesOut = 'dist-apps' }) {
  const { spawn } = await import('node:child_process')
  const { appDir } = locateApp(projectRoot)
  console.log(`[airship] 构建 ${id} 的包（注册期只读清单与图标）`)
  const { file } = await buildAndPack({ projectRoot, id, packagesOut })

  const server = await createServer({
    configFile: false,
    root: projectRoot,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port, strictPort: true }
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]?.replace(/\/$/, '')
  if (!url) throw new Error('vite dev server 起来了却没报出本地地址')

  const { findRuntime } = await import('./runtime.mjs')
  const exe = findRuntime()
  const userDataDir = join(projectRoot, '.airship-dev', id)
  // 完整文档 URL 交给 runtime——它不再猜目录形状（AIRSHIP_DEV_URL 就是那扇窗口该加载的地址）
  const rel = relative(projectRoot, appDir).split(sep).join('/')
  const devDoc = `${url}/${rel === '' ? '' : `${rel}/`}index.html`
  console.log(`[airship] dev server ${url} —— 改 ${appDir} 下的源码，窗口里刷新即见`)
  console.log(`[airship] runtime ${exe}（窗口数据在 .airship-dev/${id}，不碰日常那套 userData）`)
  const child = spawn(exe, [file, `--user-data-dir=${userDataDir}`], {
    cwd: projectRoot,
    stdio: 'ignore',
    env: { ...process.env, AIRSHIP_DEV_URL: devDoc }
  })

  let closing = false
  const shutdown = () => {
    if (closing) return
    closing = true
    if (child.exitCode === null && child.signalCode === null) child.kill()
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  child.on('exit', (code) => {
    console.log(`[airship] runtime 退出了（退出码 ${code}），dev server 跟着关`)
    shutdown()
  })
  return { child, server, file }
}

/** 直跑产物：构建装包后把包指给装好的 runtime——与双击快捷方式同一条路 */
export async function runStart({ projectRoot, id, packagesOut = 'dist-apps' }) {
  const { spawn } = await import('node:child_process')
  const { file } = await buildAndPack({ projectRoot, id, packagesOut })
  const { findRuntime } = await import('./runtime.mjs')
  const exe = findRuntime()
  console.log(`[airship] ${file} → ${exe}`)
  return new Promise((done, fail) => {
    const child = spawn(exe, [file], { cwd: projectRoot, stdio: 'inherit' })
    child.on('error', fail)
    child.on('exit', (code) => done(code ?? 0))
  })
}
