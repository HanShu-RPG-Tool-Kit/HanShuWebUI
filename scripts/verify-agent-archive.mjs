/**
 * 归档段库（打开 / 继承对话 / 级联删除）验收。
 *
 * 在真实浏览器里跑真 `AgentRuntime`（真 IndexedDB、真 pi-durable Harness），只是不调模型：
 * 直接往归档段库写一份归档，然后走 facade 的三个入口：
 *   1. `snapshotItems` 只读查看；
 *   2. `forkSnapshot` 继承出新活跃段 → 再 `archive()` 产出父链为根归档的新归档；
 *   3. `deleteSnapshot` 删根归档 → 应连带删掉继承段与它产出的归档。
 *
 * 跑法：`node scripts/verify-agent-archive.mjs`
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const PORT = 5181
const SCOPE = 'verify-archive'

function startVite() {
  const child = spawn(
    process.execPath,
    [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  return new Promise((resolveStart, reject) => {
    const timer = setTimeout(() => reject(new Error('Vite 启动超时')), 60_000)
    const lines = []
    child.stdout.on('data', (chunk) => lines.push(String(chunk)))
    child.stderr.on('data', (chunk) => lines.push(String(chunk)))
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`Vite 提前退出（${code}）：${lines.join('')}`))
    })
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
    return await chromium.launch({ headless: true, channel: 'msedge' })
  }
}

const vite = await startVite()
let browser
try {
  browser = await launchBrowser()
  const page = await browser.newPage()
  page.on('pageerror', (error) => console.error('[pageerror]', error.message))
  await page.goto(`http://localhost:${PORT}/package.json`, { waitUntil: 'domcontentloaded' })

  const result = await page.evaluate(async (scope) => {
    const mod = (path) => import(path)
    const facade = await mod('/src/agent/pi/facade.ts')
    const ids = await mod('/src/agent/store/dbNames.ts')
    const snapshotModule = await mod('/src/agent/store/snapshotStore.ts')

    // 领域工具宿主：本验收不调模型、不改工程文件，全部给"不可用"即可
    const deny = () => ({ ok: false, error: '验收未实现该工具' })
    const host = {
      listSources: deny,
      readSource: deny,
      readFullSource: deny,
      createSource: deny,
      writeSource: deny,
      deleteSource: async () => deny(),
      editSource: deny,
      renameSource: async () => deny(),
      validateSource: deny,
      getActiveFilePath: deny,
      listLocales: deny,
      listLangKeys: async () => deny(),
      writeLang: async () => deny(),
      deleteLangKeys: async () => deny(),
      listVoiceStatus: async () => deny(),
      parseHs: async () => deny(),
      unparseHs: async () => deny(),
      checkExport: async () => deny(),
      isHumanDirty: () => false,
    }

    const windowId = 'verify-window'
    // 先清掉上次失败留下的库
    const { IndexedDbStorage } = await mod('/@id/@earendil-works/pi-durable/storage/indexeddb')
    await IndexedDbStorage.delete(ids.segmentDbName(windowId, scope)).catch(() => undefined)
    await IndexedDbStorage.delete(ids.archiveDbName(scope)).catch(() => undefined)

    const assertCount = (list, expected) => {
      if (list.length !== expected) {
        throw new Error(`归档列表数量不符：期望 ${expected}，实际 ${list.length}`)
      }
    }
    const runtime = facade.createAgentRuntime({
      scope,
      windowId,
      host,
      apiKey: '',
      model: 'deepseek-flash',
      canStartRun: () => true,
    })
    await runtime.open()
    const segmentsBefore = await runtime.listSegments()

    // 直接往归档段库写一份归档（两条用户条目），模拟"保存时产出的归档段"
    const store = new snapshotModule.SnapshotStore(
      new snapshotModule.IndexedDbSnapshotBackend({ scope }),
      { scope },
    )
    const entries = [
      { id: 1, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: '第一问', timestamp: Date.now() }] },
      { id: 2, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: '第二问', timestamp: Date.now() }] },
    ]
    const rootSnapshot = {
      id: 'snap-root',
      scope,
      segmentId: segmentsBefore[0]?.id ?? '0',
      title: '验收归档',
      createdAt: Date.now(),
      entryCount: entries.length,
      tailEntryId: '2',
    }
    await store.append(rootSnapshot, entries)
    // 直接写进去的归档必须能被运行时读回（两个实例共享同一个库）
    assertCount(await store.list(), 1)

    const items = await runtime.snapshotItems('snap-root')
    const forked = await runtime.forkSnapshot('snap-root')
    const forkedArchive = await runtime.archive()
    const snapshotsAfterFork = await runtime.listSnapshots()
    const segmentsAfterFork = await runtime.listSegments()

    const cascade = await runtime.deleteSnapshot('snap-root')
    const snapshotsAfterDelete = await runtime.listSnapshots()
    const segmentsAfterDelete = await runtime.listSegments()
    // 被删归档不可再读：这里预期抛错
    let itemsAfterDelete = -2
    try {
      itemsAfterDelete = (await runtime.snapshotItems('snap-root')).length
    } catch {
      itemsAfterDelete = -1
    }

    await runtime.close()
    // 不在结尾删库：本页还开着归档段库连接（`store` 后端），deleteDatabase 会被阻塞到超时。
    // 下次运行开头的清理（此时连接都已随页面关闭）会处理残留。

    return {
      segmentsBefore: segmentsBefore.length,
      items: items.length,
      forkedId: forked.id,
      forkedSource: forked.sourceSnapshotId,
      forkedArchiveParent: forkedArchive?.parentSnapshotId,
      forkedArchiveEntries: forkedArchive?.entryCount,
      snapshotsAfterFork: snapshotsAfterFork.length,
      segmentsAfterFork: segmentsAfterFork.length,
      cascade,
      snapshotsAfterDelete: snapshotsAfterDelete.length,
      segmentsAfterDelete: segmentsAfterDelete.length,
      itemsAfterDelete,
    }
  }, SCOPE)


  assert.equal(result.items, 2, '打开归档段应读到 2 条对话')
  assert.ok(result.forkedId, '继承应产生一个新的活跃段')
  assert.equal(result.forkedSource, 'snap-root', '新段应记下来源归档')
  assert.equal(result.segmentsAfterFork, result.segmentsBefore + 1, '继承后多一个活跃段')
  assert.equal(result.forkedArchiveEntries, 2, '继承段归档应包含被继承的 2 条对话')
  assert.equal(result.forkedArchiveParent, 'snap-root', '继承段的归档父链应指向被继承的归档')
  assert.equal(result.snapshotsAfterFork, 2, '继承后应有根归档 + 新归档')
  assert.equal(result.cascade.snapshots, 2, '级联删除应删掉根归档与它的后代归档')
  assert.equal(result.cascade.segments, 1, '级联删除应删掉继承出的活跃段')
  assert.equal(result.snapshotsAfterDelete, 0, '归档段库应清空')
  assert.equal(result.segmentsAfterDelete, result.segmentsBefore, '活跃段回到继承前数量')
  assert.equal(result.itemsAfterDelete, -1, '被删归档不可再读（应抛"不存在"）')

  console.log(
    `通过：归档段打开/继承/级联删除（读 ${result.items} 条，继承段归档父链 ${result.forkedArchiveParent}，级联删 ${result.cascade.snapshots} 归档 / ${result.cascade.segments} 段）`,
  )
} finally {
  if (browser) await browser.close().catch(() => undefined)
  if (vite.exitCode === null) {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(vite.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    else vite.kill('SIGTERM')
  }
}
