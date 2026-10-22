import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A LAN request must not become a privileged loopback request through Vite. */
export function localProjectBoundary(): Plugin {
  function guard(request: IncomingMessage, response: ServerResponse, next: () => void) {
    let path = new URL(request.url ?? '/', 'http://localhost').pathname
    try { path = decodeURIComponent(path).replace(/\/+/g, '/') } catch { /* Invalid paths will not match a service endpoint. */ }
    const local = request.socket.remoteAddress ?? ''
    if (!(local === '::1' || local.startsWith('127.') || local.startsWith('::ffff:127.'))) request.headers['x-hanshu-remote-client'] = '1'
    else delete request.headers['x-hanshu-remote-client']
    if (/^\/__project\/api\/(?:local(?:\/|-|$)|accounts(?:\/|$)|share\/firewall(?:\/|$))/.test(path) && !(local === '::1' || local.startsWith('127.') || local.startsWith('::ffff:127.'))) {
      response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify({ code: 'forbidden', message: '请通过本机 WebUI 打开本机工程' }))
      return
    }
    next()
  }
  return { name: 'hanshu-local-project-boundary', configureServer(server) { server.middlewares.use(guard) }, configurePreviewServer(server) { server.middlewares.use(guard) } }
}
