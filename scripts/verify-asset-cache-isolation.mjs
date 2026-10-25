import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, appType: 'custom', server: { host: '127.0.0.1', port: 0 }, optimizeDeps: { noDiscovery: true, include: [] } })
server.middlewares.use((request, response, next) => {
  if (request.url !== '/cache-test') return next()
  response.setHeader('Content-Type', 'text/html')
  response.end('<!doctype html><html><head><title>Asset cache isolation</title></head><body>Asset cache isolation</body></html>')
})
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/cache-test`
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) })
  // Same context intentionally shares the real IndexedDB backend between tabs.
  const context = await browser.newContext()
  const a = await context.newPage(); const b = await context.newPage()
  async function load(page) { await page.goto(url); await page.evaluate(async () => { window.cache = await import('/src/assets/idb.ts') }) }
  const put = (page, pkg, path, body) => page.evaluate(async ({ pkg, path, body }) => window.cache.putAssetBlob(pkg, path, new Blob([body])), { pkg, path, body })
  const read = (page, pkg, path) => page.evaluate(async ({ pkg, path }) => (await window.cache.getAssetBlob(pkg, path))?.text() ?? null, { pkg, path })
  await Promise.all([load(a), load(b)])
  const lang = 'assets/zh_cn/lang_quest/example.lang'
  const audio = 'assets/zh_cn/voice_hs/story/line.ogg'
  await put(a, 'shared-project', lang, 'A unsaved translation')
  assert.equal(await read(b, 'shared-project', lang), null)
  await put(b, 'shared-project', lang, 'B server translation')
  assert.equal(await read(a, 'shared-project', lang), 'A unsaved translation')
  assert.equal(await read(b, 'shared-project', lang), 'B server translation')
  await put(a, 'shared-project', audio, 'A unsaved recording')
  assert.equal(await read(b, 'shared-project', audio), null)
  const rawCount = await b.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('hanshu.assets.v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    const count = await new Promise((resolve, reject) => { const request = db.transaction('blobs').objectStore('blobs').count(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) })
    db.close(); return count
  })
  assert.equal(rawCount, 3, 'The tabs must use a shared database with isolated keys, not isolated browser profiles')
  await b.evaluate(() => window.cache.deletePackageAssetBlobs('shared-project'))
  assert.equal(await read(b, 'shared-project', lang), null)
  assert.equal(await read(a, 'shared-project', lang), 'A unsaved translation')
  assert.equal(await read(a, 'shared-project', audio), 'A unsaved recording')
  await put(b, 'shared-project', lang, 'B local draft')
  await a.evaluate(() => window.cache.deleteCurrentAssetCache())
  assert.equal(await read(a, 'shared-project', lang), null)
  assert.equal(await read(b, 'shared-project', lang), 'B local draft')
  await put(a, 'shared-project', lang, 'old runtime only')
  await load(a)
  assert.equal(await read(a, 'shared-project', lang), null, 'A new runtime must not reuse another or its previous page cache')
  await put(a, 'shared-project', lang, 'restored draft from journal')
  assert.equal(await read(a, 'shared-project', lang), 'restored draft from journal')
  assert.equal(await read(b, 'shared-project', lang), 'B local draft')
  const epoch = await a.evaluate(path => window.cache.assetCacheEpoch('shared-project', path), lang)
  await put(a, 'shared-project', lang, 'newer local draft')
  const deleted = await a.evaluate(({ path, epoch }) => window.cache.deleteCachedAsset('shared-project', path, epoch), { path: lang, epoch })
  assert.equal(deleted, false)
  assert.equal(await read(a, 'shared-project', lang), 'newer local draft')
  console.log('Asset cache isolation passed: same-origin same-profile tabs, translations/binary drafts, scoped package/runtime cleanup, reload scope and guarded deletion.')
} finally { await browser?.close(); await server.close() }
