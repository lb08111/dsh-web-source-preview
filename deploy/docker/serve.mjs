import http from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootstrap } from './bootstrap.mjs'
import { isAllowedBrowserRequest } from './access-policy.mjs'
import { relaxAuthCookieSameSite } from './auth-cookie.mjs'

const publicUrl = new URL(process.env.PUBLIC_URL || 'http://127.0.0.1:3080')
if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
  throw new Error('PUBLIC_URL must be one HTTP(S) origin without credentials, a path, query, or fragment')
}
const upstreamAuthority = '127.0.0.1:3080'
const upstreamOrigin = `http://${upstreamAuthority}`
bootstrap()

function trusted(request, pathname) {
  return isAllowedBrowserRequest(request, publicUrl, pathname)
}

function upstreamHeaders(request) {
  const headers = { ...request.headers, host: upstreamAuthority }
  for (const name of Object.keys(headers)) {
    if (name.startsWith('x-forwarded-') || ['forwarded', 'cf-connecting-ip', 'cf-ipcountry', 'true-client-ip'].includes(name)) delete headers[name]
  }
  if (headers.origin !== undefined) headers.origin = upstreamOrigin
  return headers
}

function authenticate(request) {
  return new Promise(resolve => {
    const probe = http.request({
      hostname: '127.0.0.1', port: 3080, method: 'GET', path: '/',
      headers: { host: upstreamAuthority, cookie: request.headers.cookie || '' },
      timeout: 5000,
    }, response => {
      // The native index checks the signed browser-owner cookie. An API-peer
      // credential cannot grant access to the container's management routes.
      response.resume()
      resolve(response.statusCode === 200)
    })
    probe.on('timeout', () => probe.destroy())
    probe.on('error', () => resolve(false))
    probe.end()
  })
}

function reject(response, status = 401) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  response.end(status === 401 ? '请使用部署脚本输出的带 token 地址登录。\n' : '请求来源不匹配 PUBLIC_URL。\n')
}

const server = http.createServer(async (request, response) => {
  let path
  try {
    path = new URL(request.url || '/', publicUrl)
  } catch {
    reject(response, 400)
    return
  }
  const login = request.method === 'GET' && path.pathname === '/' && path.searchParams.has('token')
  if (!trusted(request, path.pathname) && !(login && request.headers.host?.toLowerCase() === publicUrl.host.toLowerCase() && request.headers.origin === undefined)) {
    reject(response, 403)
    return
  }
  if (!login && !await authenticate(request)) {
    reject(response)
    return
  }
  const proxy = http.request({ hostname: '127.0.0.1', port: 3080, path: request.url, method: request.method, headers: upstreamHeaders(request) }, result => {
    const headers = { ...result.headers }
    if (headers['set-cookie']) headers['set-cookie'] = relaxAuthCookieSameSite(headers['set-cookie'])
    if (publicUrl.protocol === 'https:' && headers['set-cookie']) {
      headers['set-cookie'] = headers['set-cookie'].map(cookie => /;\s*secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure')
    }
    response.writeHead(result.statusCode || 502, headers)
    result.pipe(response)
  })
  proxy.on('error', () => { if (!response.headersSent) reject(response, 503); else response.destroy() })
  request.pipe(proxy)
})

server.on('upgrade', async (request, socket, head) => {
  socket.on('error', () => socket.destroy())
  if (!trusted(request) || !await authenticate(request)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    return
  }
  const proxy = http.request({ hostname: '127.0.0.1', port: 3080, path: request.url, headers: upstreamHeaders(request) })
  proxy.on('upgrade', (response, upstream, upstreamHead) => {
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`]
    for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
    socket.write(lines.join('\r\n') + '\r\n\r\n')
    if (head.length) upstream.write(head)
    if (upstreamHead.length) socket.write(upstreamHead)
    upstream.pipe(socket).pipe(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  proxy.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume() })
  proxy.on('error', () => socket.destroy())
  proxy.end()
})

const child = spawn(process.execPath, [
  '/opt/dsh/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
  '--profile', 'web', '--host', '127.0.0.1', '--port', '3080', '--no-open',
], { cwd: '/workspace', stdio: ['ignore', 'pipe', 'inherit'], env: process.env })
let output = ''
child.stdout.on('data', chunk => {
  process.stdout.write(chunk)
  output = (output + chunk.toString()).slice(-32768)
  const match = output.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)
  if (match) {
    const entry = new URL('/', publicUrl)
    entry.searchParams.set('token', match[1])
    const file = join(process.env.DSH_HOME || '/data', '.browser-entry')
    writeFileSync(file, entry.href + '\n', { mode: 0o600 })
    chmodSync(file, 0o600)
    console.log(`DSH_BROWSER_URL=${entry.href}`)
    output = ''
  }
})
let stopping = false
function shutdown(signal = 'SIGTERM') {
  if (stopping) return
  stopping = true
  server.close()
  child.kill(signal)
  const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
  timer.unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', () => shutdown('SIGINT'))
child.on('error', error => { console.error(error.message); server.close(); process.exitCode = 1 })
child.on('exit', (code, signal) => { server.close(); process.exitCode = stopping ? 0 : code || (signal ? 1 : 0) })
server.listen(8080, '0.0.0.0')
