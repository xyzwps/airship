import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'

/**
 * 本地预览官网：`node code/serve-site.mjs [端口]`（入口配方 `just site [端口]`）
 *
 * src/websites 是纯静态的，没有构建步骤——这个脚本只干一件事：把那几份文件当 http 站点端出来，
 * 好让相对链接、CSP 无关的字体与主题切换在浏览器里跟真部署一个样子（file:// 下 localStorage 与
 * 跨页行为有时不一样）。
 *
 * 三条硬规矩：
 *   只绑 127.0.0.1——预览是本机的事，不该把仓库目录暴露到局域网上；
 *   路径必须落在 src/websites 里面——`..` 与越界请求直接 404，不做任何"聪明的"回退；
 *   响应一律 no-store——改完刷新就见效，不留一份旧页面冒充新改动。
 */

const ROOT = resolve(import.meta.dirname, '..')
const SITE = join(ROOT, 'src', 'websites')

const PORT = Number(process.argv[2] ?? process.env.AIRSHIP_SITE_PORT ?? 4321)
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`端口 "${process.argv[2]}" 不是 1-65535 的整数`)
  process.exit(1)
}

if (!existsSync(join(SITE, 'index.html'))) {
  console.error(`没找到 ${SITE}\\index.html——预览的是 src/websites 这个目录，别的位置不在这一条里`)
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
}

/** 把 URL 路径换成站点目录内的真文件路径；越界或目录返回 null */
function fileFor(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0].split('#')[0])
  let rel = normalize(clean.replace(/^\/+/, '')).replace(/^(\.\.[\\/])+/, '')
  if (rel === '' || rel === '.') rel = 'index.html'
  const abs = resolve(SITE, rel)
  // 越界判据：必须仍在 SITE 之下（带分隔符，免得 src/websites-evil 这种同前缀目录混过去）
  if (abs !== SITE && !abs.startsWith(SITE + sep)) return null
  if (!existsSync(abs) || !statSync(abs).isFile()) return null
  return abs
}

const server = createServer((req, res) => {
  const abs = fileFor(req.url ?? '/')
  if (!abs) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>没有这个页面</title>' +
        '<p style="font:16px/1.7 system-ui;padding:40px">预览里没有这个页面：<code>' +
        String(req.url ?? '/').replace(/[<>&]/g, '') +
        '</code><br><a href="/">回首页</a> · <a href="/docs.html">文档</a> · <a href="/develop.html">开发教程</a></p>'
    )
    console.log(`404  ${req.url}`)
    return
  }
  const body = readFileSync(abs)
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  })
  res.end(req.method === 'HEAD' ? undefined : body)
  console.log(`200  ${req.url}  →  ${abs.slice(SITE.length + 1).split(sep).join('/')}`)
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已经被占了：换一个，跑 just site 5173 这样带个参数`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`官网预览：http://127.0.0.1:${PORT}/`)
  console.log(`  首页    http://127.0.0.1:${PORT}/`)
  console.log(`  文档    http://127.0.0.1:${PORT}/docs.html`)
  console.log(`  教程    http://127.0.0.1:${PORT}/develop.html`)
  console.log(`目录      ${SITE}`)
  console.log('Ctrl+C 停')
})
