import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { deflateSync } from 'node:zlib'

export const skinIndexPath = '.hanshu/skinmanager/library.json'
export const progressPath = 'src/progress/example.progress'
export const progressLangPath = 'assets/zh_cn/lang_progress/example.lang'
export const scriptPath = 'src/hanshu/story.hs'
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function until(check, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (!await check()) { assert.ok(Date.now() < deadline, label); await sleep(100) }
}

export function skinFixture(color = 255) {
  const rgba = Buffer.alloc(64 * 64 * 4, 255)
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = color; rgba[offset + 1] = 120; rgba[offset + 2] = 200
  }
  const canonical = Buffer.alloc(15 + rgba.length)
  canonical.write('HSKN'); canonical[4] = 1
  canonical.writeUInt16BE(64, 7); canonical.writeUInt16BE(64, 9)
  canonical.writeUInt32BE(rgba.length, 11); rgba.copy(canonical, 15)
  const skinId = createHash('sha256').update(canonical).digest('hex')
  const compressed = deflateSync(rgba), object = Buffer.alloc(16 + compressed.length)
  canonical.copy(object, 0, 0, 11); object[11] = 1
  object.writeUInt32BE(compressed.length, 12); compressed.copy(object, 16)
  const now = '2026-10-22T00:00:00.000Z'
  const entry = (entryId, name) => ({
    entryId, skinId, name, active: true, tags: [], folderId: null, favorite: false,
    model: 'classic', textureWidth: 64, textureHeight: 64, source: { kind: 'skin-file' },
    provenance: { author: null, sourceName: null, sourceUrl: null, sourceNote: null, originalCreatedAt: null },
    license: { status: 'unspecified', name: null, url: null, note: null },
    note: '', customId: null, createdAt: now, updatedAt: now, revision: 1,
  })
  return { skinId, objectPath: `.hanshu/skinmanager/objects/${skinId.slice(0, 2)}/${skinId}.skin`, object, entry }
}

export function restoreCommit(plan) {
  return {
    transactionId: randomUUID(),
    changes: [{
      op: 'history-restore', path: 'project.json', version: null,
      content: Buffer.from(JSON.stringify(plan.request)).toString('base64'),
      destination: null, destinationVersion: null, leaseId: '',
    }],
  }
}

// A public HTTP/WebSocket proxy that can lose exactly one successful restore
// reply. It never alters the request or invents a server outcome.
export async function replyLossProxy() {
  const sockets = new Set(), observed = []
  let upstream = '', dropRestore = false
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const commit = req.url === '/api/files/commit' ? JSON.parse(body.toString()) : null
    if (commit) observed.push(commit)
    const drop = dropRestore && commit?.changes.some(change => change.op === 'history-restore')
    if (drop) dropRestore = false
    const target = new URL(req.url, upstream)
    const outgoing = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, async response => {
      const received = []; for await (const chunk of response) received.push(chunk)
      const content = Buffer.concat(received)
      if (drop && JSON.parse(content).status === 'committed') {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': content.length })
        res.write(content.subarray(0, Math.max(1, Math.floor(content.length / 2))))
        setTimeout(() => res.destroy(), 20)
      } else { res.writeHead(response.statusCode, response.headers); res.end(content) }
    })
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('{"code":"unavailable","message":"Test proxy upstream is unavailable"}') })
    outgoing.end(body)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  server.on('upgrade', (req, socket, head) => {
    const target = new URL(upstream)
    const remote = connect(Number(target.port), target.hostname, () => {
      remote.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`)
      for (const [key, value] of Object.entries(req.headers)) remote.write(`${key}: ${key === 'host' ? target.host : value}\r\n`)
      remote.write('\r\n'); if (head.length) remote.write(head)
      socket.pipe(remote); remote.pipe(socket)
    })
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    base: `http://127.0.0.1:${server.address().port}`, observed,
    setUpstream(value) { upstream = value },
    dropNextRestore() { dropRestore = true },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}
