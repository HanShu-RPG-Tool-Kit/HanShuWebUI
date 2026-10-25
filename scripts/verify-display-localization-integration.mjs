import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createServer } from 'vite'
import { harness } from './collaboration-harness.mjs'

// Exercise the shipping client against S. Faults only affect transport after S replies.
async function transportProxy(upstream) {
  const sockets = new Set(), commits = [], queries = [], receipts = []
  let drop = false
  const server = createHttpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const commit = req.url === '/api/files/commit' ? JSON.parse(body.toString()) : null
    if (commit) commits.push(commit)
    if (req.url.startsWith('/api/files/transactions/')) queries.push(req.url)
    const loseReply = !!commit && drop
    if (loseReply) drop = false
    const outgoing = httpRequest(new URL(req.url, upstream), { method: req.method, headers: { ...req.headers, host: new URL(upstream).host } }, async response => {
      const received = []; for await (const chunk of response) received.push(chunk)
      const content = Buffer.concat(received)
      if (commit) receipts.push(JSON.parse(content.toString()))
      if (loseReply && JSON.parse(content.toString()).status === 'committed') {
        res.writeHead(response.statusCode, { 'Content-Type': 'application/json', 'Content-Length': content.length })
        res.write(content.subarray(0, Math.max(1, Math.floor(content.length / 2))))
        setTimeout(() => res.destroy(), 10)
      } else { res.writeHead(response.statusCode, response.headers); res.end(content) }
    })
    outgoing.on('error', () => { if (!res.headersSent) res.writeHead(503); res.end('{"code":"unavailable","message":"Integration proxy upstream unavailable"}') })
    outgoing.end(body)
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${server.address().port}`, commits, queries, receipts,
    dropNext() { drop = true },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) },
  }
}

const types = ['item', 'entity']
const cases = ['happy', 'source-conflict', 'locale-conflict', 'unknown', 'viewer', 'offline', 'switch', 'revoke']
const string = value => ({ type: 'string', value })
function fixture(kind, name) {
  const component = { type: 'compound', value: { translate: string(`hanshu.${kind}.${name}.display.custom_name`), color: string('gold'), italic: { type: 'byte', value: 0 } } }
  if (kind === 'item') return { format: 'rpgtoolkit:item', schemaVersion: 2, tags: ['original'], item: { id: 'minecraft:stick', components: { 'minecraft:custom_name': component } } }
  return { format: 'rpgtoolkit:entity-template', version: 1, dataFormat: 'tnbt-json-v1', tags: ['original'], entity: { id: 'minecraft:zombie', data: { type: 'compound', value: { CustomName: component, Health: { type: 'float', value: '20' } } } } }
}
async function seed(h, token) {
  const edits = []
  for (const kind of types) for (const name of cases) {
    edits.push({ path: `src/${kind === 'item' ? 'items' : 'entities'}/${name}.${kind}`, content: JSON.stringify(fixture(kind, name), null, 2) })
    for (const [locale, value] of [['zh_cn', '初始名称'], ['en_us', 'Original Name']]) edits.push({ path: `assets/${locale}/lang_${kind}/${name}.lang`, content: JSON.stringify({ 'display.custom_name': value, unrelated: 'Keep unrelated key' }, null, 2) })
  }
  await h.commit(token, edits)
  await h.release(token)
}
let service, other, proxy, vite
let evidence
try {
  const reservation = createHttpServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const origin = `http://127.0.0.1:${port}`
  service = await harness({ origins: [origin] })
  other = await harness({ origins: [origin] })
  const owner = await service.login(service.credential, 'Display localization integration A')
  const peer = await service.login(service.credential, 'Display localization integration B')
  const viewerAccount = await service.api(owner.token, '/api/subjects', 'POST', { name: 'Display viewer', kind: 'person', role: 'viewer' })
  const viewer = await service.login(viewerAccount.credential, 'Display viewer')
  const editorAccount = await service.api(owner.token, '/api/subjects', 'POST', { name: 'Revocable display editor', kind: 'person', role: 'editor' })
  const revocable = await service.login(editorAccount.credential, 'Revocable display editor')
  const otherOwner = await other.login(other.credential, 'Other project')
  await seed(service, owner.token)
  await seed(other, otherOwner.token)
  proxy = await transportProxy(service.base)
  const bootstrap = {
    runId: randomUUID(),
    owner: { token: owner.token, snapshot: await service.api(owner.token, '/api/project') },
    peer: { token: peer.token, snapshot: await service.api(peer.token, '/api/project') },
    viewer: { token: viewer.token, snapshot: await service.api(viewer.token, '/api/project') },
    revocable: { token: revocable.token, snapshot: await service.api(revocable.token, '/api/project') },
    other: { token: otherOwner.token, snapshot: await other.api(otherOwner.token, '/api/project') },
  }
  vite = await createServer({
    root: process.cwd(), appType: 'custom',
    server: { host: '127.0.0.1', port, strictPort: true, proxy: {
      '/integration-service': { target: proxy.url, changeOrigin: true, rewrite: path => path.replace('/integration-service', '') },
      '/integration-other': { target: other.base, changeOrigin: true, rewrite: path => path.replace('/integration-other', '') },
    } },
    plugins: [{ name: 'display-localization-integration', configureServer(server) {
      server.middlewares.use('/integration-bootstrap', (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(bootstrap)) })
      server.middlewares.use('/integration-fault', async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        if (Buffer.concat(chunks).toString() === 'drop') proxy.dropNext()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ commits: proxy.commits, queries: proxy.queries, receipts: proxy.receipts }))
      })
      server.middlewares.use('/integration-revoke', async (_req, res) => {
        await service.api(owner.token, `/api/subjects/${editorAccount.subject.id}`, 'PATCH', { role: 'viewer' })
        res.setHeader('Content-Type', 'application/json'); res.end('{}')
      })
      server.middlewares.use('/integration-result', async (req, res) => {
        const chunks = []; for await (const chunk of req) chunks.push(chunk)
        evidence = JSON.parse(Buffer.concat(chunks).toString())
        res.setHeader('Content-Type', 'application/json'); res.end('{}')
      })
      server.middlewares.use('/display-localization-integration', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/display-localization-integration', '<!doctype html><html><meta charset="utf-8"><title>Display localization integration</title><body><pre id="results">Starting real project integration…</pre><script type="module" src="/scripts/verify-display-localization-integration.ts"></script></body></html>'))
      })
    } }],
  })
  await vite.listen()
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/display-localization-integration`
  const browserScript = `const task=await useOrCreateTaskSpace('Hanshu 本地化事务集成验收');\nawait openOrReuseTab(${JSON.stringify(url + '?actor=peer')},{wait:true,timeout:30});\nfor(const tab of await listTabs())if(tab.url.includes('/display-localization-integration')&&tab.url!==${JSON.stringify(url + '?actor=peer')})await closeTab(tab.targetId);\ncliLog(await js('(async()=>{const deadline=Date.now()+8000;while(!window.integrationPeerReady){if(Date.now()>deadline)throw Error("Peer initialization timed out");await new Promise(r=>setTimeout(r,50))}return "Peer initialized"})()'));\nawait openOrReuseTab(${JSON.stringify(url)},{wait:true,timeout:30});\ncliLog('Real two-window integration dispatched');`
  const browser = spawn(process.env.EGO_BROWSER_BIN ?? '/Users/muzermat/.local/bin/ego-browser', ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
  browser.stdin.end(browserScript)
  browser.stdout.on('data', data => process.stdout.write(data))
  browser.stderr.on('data', data => process.stderr.write(data))
  const exit = await new Promise((resolve, reject) => { browser.once('error', reject); browser.once('exit', resolve) })
  assert.equal(exit, 0, 'Ego Lite integration browser failed')
  const deadline = Date.now() + 120000
  while (!evidence && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.ok(evidence?.ok, JSON.stringify(evidence ?? { error: 'Browser returned no evidence' }, null, 2))
  for (const check of evidence.checks) console.log(`通过：${check}`)
  console.log(`通过：真实双窗口/双会话工程服务本地化集成，共 ${evidence.checks.length} 项。`)
  // Cleanup is a separate final browser invocation, after the preceding result proved completion.
  const cleanup = spawn(process.env.EGO_BROWSER_BIN ?? '/Users/muzermat/.local/bin/ego-browser', ['nodejs'], { stdio: ['pipe', 'inherit', 'inherit'] })
  cleanup.stdin.end("cliLog(await completeTaskSpace('Hanshu 本地化事务集成验收',{keep:false}));")
  await new Promise((resolve, reject) => { cleanup.once('error', reject); cleanup.once('exit', resolve) })
} finally {
  await vite?.close()
  await proxy?.close()
  await service?.stop()
  await other?.stop()
}
