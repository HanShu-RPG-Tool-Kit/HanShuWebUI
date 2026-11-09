/**
 * 删除活跃段（IndexedDB 层）验收。
 *
 * 为什么必须跑浏览器：`deleteSegmentRecords` 直接操作 pi-durable 的 IndexedDB 库结构，
 * Node 里没有 IndexedDB。这里启动 Vite（只跑前端）、用 Playwright 在真实页面里：
 *   建两个会话 → 各写条目/文档 → 关闭 Harness → 调用删除 → 重新打开核对记录真的没了。
 *
 * 跑法：`node scripts/verify-agent-segment-purge.mjs`
 * 依赖：playwright（仓库已有）+ 本机 Edge/Chromium。
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const PORT = 5179
const DB_NAME = 'hanshu.verify.segment-purge'

function startVite() {
  const child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite 启动超时')), 60_000)
    const lines = []
    const onData = (chunk) => lines.push(String(chunk))
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite 提前退出（${code}）：${lines.join('')}`))
    })
    // 输出 "ready" 不等于端口已经能连：轮询 HTTP，直到 200
    const poll = async () => {
      for (let i = 0; i < 120; i += 1) {
        try {
          const response = await fetch(`http://localhost:${PORT}/`)
          if (response.ok) {
            clearTimeout(timer)
            resolveStart(child)
            return
          }
        } catch {
          /* 还没起来 */
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      clearTimeout(timer)
      reject(new Error('Vite 端口未就绪'))
    }
    void poll()
  })
}

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true })
  } catch {
    // 仓库其它 UI 验收在 Windows 上走 Edge
    return await chromium.launch({ headless: true, channel: 'msedge' })
  }
}

const vite = await startVite()
let browser
try {
  browser = await launchBrowser()
  const page = await browser.newPage()
  page.on('pageerror', (error) => console.error('[pageerror]', error.message))
  // 用一个**不启动应用**的同源文档：应用会自己跳转（splash/会话），会把 evaluate 的上下文销毁。
  // package.json 由 Vite 原样提供，同源、无脚本，正好只用来拿 IndexedDB 与模块图。
  await page.goto(`http://localhost:${PORT}/package.json`, { waitUntil: 'domcontentloaded' })

  const result = await page.evaluate(async (dbName) => {
    const mod = async (path) => import(path)
    // 用 Vite 的裸模块入口（/@id/）而不是 node_modules 直链：CJS 依赖需要经过预打包转换
    const durable = await mod('/@id/@earendil-works/pi-durable')
    const indexeddb = await mod('/@id/@earendil-works/pi-durable/storage/indexeddb')
    const chord = await mod('/@id/@earendil-works/chord/context')
    const piAi = await mod('/@id/@earendil-works/pi-ai')
    const fauxModule = await mod('/@id/@earendil-works/pi-ai/providers/faux')
    const purge = await mod('/src/agent/store/segmentPurge.ts')

    const ctx = chord.BACKGROUND_CONTEXT
    await indexeddb.IndexedDbStorage.delete(dbName).catch(() => undefined)

    const storage = await indexeddb.IndexedDbStorage.open(dbName)
    const harness = await durable.Harness.open(
      storage,
      {
        // 删除逻辑不需要真模型：用 pi-ai 的 faux provider 满足 Harness 的装配要求
        models: (() => {
          const handle = fauxModule.fauxProvider()
          const models = piAi.createModels()
          models.setProvider(handle.provider)
          return models
        })(),
        registry: durable.createRegistry(),
      },
      ctx,
    )

    const keep = await harness.createConversation({ ownership: { kind: 'ownerless' } }, ctx)
    const doomed = await harness.createConversation({ ownership: { kind: 'ownerless' } }, ctx)
    // 正常提交路径写一条条目（含 pi 文档创建），确保删除覆盖 entries / documents 两类记录
    await keep.commit((tx) => tx.appendEntry(keep.id, { kind: 'app.note', data: { note: 'keep' } }), ctx)
    await doomed.commit(
      (tx) => tx.appendEntry(doomed.id, { kind: 'app.note', data: { note: 'doomed' } }),
      ctx,
    )
    await doomed.configure({ model: { provider: 'faux', modelId: 'faux' } }, ctx)

    const keepId = Number(keep.id)
    const doomedId = Number(doomed.id)
    await harness.close(ctx)

    const purgeResult = await purge.deleteSegmentRecords({
      databaseName: dbName,
      conversationId: doomedId,
    })

    // 重新打开：被删会话不应再出现，另一段完好
    const reopened = await indexeddb.IndexedDbStorage.open(dbName)
    const conversations = await reopened.scanConversations({}, 100, undefined, ctx)
    // 被删会话已经不在：scanEntries 会以「未知会话」拒绝，这正是"记录真的没了"的证据
    let doomedEntriesError = ''
    try {
      await reopened.scanEntries(
        { conversationId: doomedId, order: 'ascending' },
        100,
        undefined,
        ctx,
      )
    } catch (error) {
      doomedEntriesError = String(error?.message ?? error)
    }
    const keepEntries = await reopened.scanEntries(
      { conversationId: keepId, order: 'ascending' },
      100,
      undefined,
      ctx,
    )
    let doomedDocuments = 0
    try {
      const documents = await reopened.scanDocuments(
        { scope: { kind: 'conversation', conversationId: doomedId } },
        100,
        undefined,
        ctx,
      )
      doomedDocuments = documents.items.length
    } catch {
      // 文档库里已无该会话的元数据：同样视为删干净
    }
    await reopened.close(ctx)
    await indexeddb.IndexedDbStorage.delete(dbName).catch(() => undefined)

    return {
      purgeResult,
      conversationIds: conversations.items.map((item) => Number(item.id)),
      keepId,
      doomedId,
      doomedEntriesError,
      keepEntries: keepEntries.items.length,
      doomedDocuments,
      deleted: conversations.items.length,
    }
  }, DB_NAME)

  assert.equal(result.purgeResult.deleted, true, '库存在时应执行删除')
  assert.ok(result.purgeResult.entries >= 1, '应至少删掉一条条目')
  assert.deepEqual(
    [...result.conversationIds].sort((a, b) => a - b),
    [result.keepId],
    '只删掉目标会话，另一段必须完好',
  )
  assert.ok(
    result.doomedEntriesError.includes('Unknown conversation'),
    `被删会话不应再可读（实际：${result.doomedEntriesError}）`,
  )
  assert.ok(result.keepEntries >= 1, '另一段的条目不能被误删')
  assert.equal(result.doomedDocuments, 0, '被删会话的文档必须一起清掉')

  console.log(
    `通过：删除活跃段（条目 ${result.purgeResult.entries} 条、文档 ${result.purgeResult.documents} 个，另一段完好）`,
  )
} finally {
  if (browser) await browser.close().catch(() => undefined)
  if (vite.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else vite.kill('SIGTERM')
  }
}
