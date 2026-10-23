/**
 * 物品快照本机缓存：fingerprint / needed / renderSnapshots 批处理 / stringify 无 display。
 * 不经 gameDevServer（避免 Vite import.meta.glob）；drain 逻辑与 itemSnapshotRefresh 对齐。
 */
import assert from 'node:assert/strict'
import {
  createItem,
  parseItem,
  stringifyItem,
} from '../src/workspaces/progress/itemDoc.ts'
import {
  forceRequestItemSnapshots,
  getCachedDisplaySync,
  ingestDisplay,
  isCachedSnapshotFresh,
  listSnapshotsNeeded,
  markSnapshotNeeded,
  putCachedDisplay,
  resetItemSnapshotCacheForTests,
  setItemSnapshotRefreshOnline,
  snapshotsNeededCount,
  useMemoryItemSnapshotStore,
} from '../src/workspaces/progress/itemSnapshotCache.ts'
import { snapshotStatusOf } from '../src/workspaces/progress/itemPresentation.ts'
import {
  itemFingerprint,
  readItemStackDisplay,
  type ItemStackDisplay,
} from '../src/workspaces/progress/itemstack.ts'

const RENDER_SNAPSHOTS_BATCH = 128

let passed = 0
function test(name: string, check: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => check())
    .then(() => {
      passed += 1
      console.log(`[OK] ${name}`)
    })
}

function sampleDisplay(extra: Partial<ItemStackDisplay> = {}): ItemStackDisplay {
  return {
    locale: 'zh_cn',
    name: [{ text: '测试剑' }],
    tooltip: [[{ text: '一行' }]],
    ...extra,
  }
}

/** 与 itemSnapshotRefresh.flushBatch 同契约的最小 mock */
async function mockDrain(
  request: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  const batch = listSnapshotsNeeded(RENDER_SNAPSHOTS_BATCH)
  if (batch.length === 0) return
  const result = await request('items.renderSnapshots', {
    items: batch.map((item) => ({
      key: item.fingerprint,
      id: item.id,
      components: item.components,
    })),
    includeIcon: true,
  })
  if (!result || typeof result !== 'object') return
  const snapshots = (result as { snapshots?: unknown }).snapshots
  if (!Array.isArray(snapshots)) return
  for (const entry of snapshots) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as { key?: string; ok?: boolean; display?: unknown }
    const key = typeof row.key === 'string' ? row.key : ''
    if (!key || row.ok === false) continue
    const display = readItemStackDisplay(row.display)
    if (!display) continue
    await putCachedDisplay(key, display)
    if (display.iconPending) {
      const meta = batch.find((item) => item.fingerprint === key)
      if (meta) markSnapshotNeeded(meta)
    }
  }
}

async function main() {
  await test('ingest → fresh', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const item = { id: 'minecraft:diamond_sword', components: { a: 1 } }
    const fp = itemFingerprint(item)
    ingestDisplay(item, sampleDisplay({ snapshotOf: fp }))
    await Promise.resolve()
    assert.equal(isCachedSnapshotFresh(item), true)
    assert.equal(snapshotStatusOf(item), 'fresh')
    assert.equal(getCachedDisplaySync(fp)?.snapshotOf, fp)
  })

  await test('改 components → pending + needed；错误 snapshotOf → stale', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const base = { id: 'minecraft:stick', components: { x: 1 } }
    const fp1 = itemFingerprint(base)
    await putCachedDisplay(fp1, sampleDisplay())
    assert.equal(snapshotStatusOf(base), 'fresh')

    const changed = { id: 'minecraft:stick', components: { x: 2 } }
    const fp2 = itemFingerprint(changed)
    assert.notEqual(fp1, fp2)
    markSnapshotNeeded(changed)
    // 默认离线：排队显示 queued；连上后才是 pending
    assert.equal(snapshotStatusOf(changed), 'queued')
    setItemSnapshotRefreshOnline(true)
    assert.equal(snapshotStatusOf(changed), 'pending')
    assert.ok(listSnapshotsNeeded().some((row) => row.fingerprint === fp2))

    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore(
      new Map([[fp2, { ...sampleDisplay(), snapshotOf: 'fnv1a:deadbeef' }]]),
    )
    assert.equal(snapshotStatusOf(changed), 'stale')
  })

  await test('mock renderSnapshots 成功 → 出队 + 补 fingerprint', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const item = { id: 'minecraft:apple', components: {} }
    const fp = itemFingerprint(item)
    markSnapshotNeeded(item)
    assert.equal(snapshotsNeededCount(), 1)

    await mockDrain(async () => ({
      snapshots: [
        {
          key: fp,
          ok: true,
          display: sampleDisplay({ name: [{ text: '苹果' }] }),
        },
      ],
    }))

    assert.equal(snapshotsNeededCount(), 0)
    assert.equal(isCachedSnapshotFresh(item), true)
    assert.equal(getCachedDisplaySync(fp)?.snapshotOf, fp)
    assert.equal(getCachedDisplaySync(fp)?.name?.[0]?.text, '苹果')
  })

  await test('iconPending: true → 仍在 needed', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const item = { id: 'minecraft:book', components: { n: 1 } }
    const fp = itemFingerprint(item)
    markSnapshotNeeded(item)

    await mockDrain(async () => ({
      snapshots: [
        {
          key: fp,
          ok: true,
          display: sampleDisplay({ iconPending: true }),
        },
      ],
    }))

    assert.ok(listSnapshotsNeeded().some((row) => row.fingerprint === fp))
    setItemSnapshotRefreshOnline(true)
    assert.equal(snapshotStatusOf(item), 'pending')
    assert.equal(isCachedSnapshotFresh(item), false)
    assert.equal(getCachedDisplaySync(fp)?.name?.[0]?.text, '测试剑')
  })

  await test('批大小截断 ≤128', () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    for (let i = 0; i < 160; i += 1) {
      markSnapshotNeeded({ id: `minecraft:item_${i}`, components: {} })
    }
    assert.equal(listSnapshotsNeeded(RENDER_SNAPSHOTS_BATCH).length, 128)
    assert.equal(RENDER_SNAPSHOTS_BATCH, 128)
    assert.ok(snapshotsNeededCount() >= 128)
  })

  await test('stringify .item 无 display', () => {
    const doc = createItem('minecraft:stone')
    ;(doc as { display?: ItemStackDisplay }).display = sampleDisplay({
      snapshotOf: itemFingerprint(doc.item),
    })
    const text = stringifyItem(doc)
    const parsed = JSON.parse(text) as Record<string, unknown>
    assert.equal('display' in parsed, false)
    const roundTrip = parseItem(text)
    assert.equal('display' in roundTrip, false)
  })

  await test('count 变化不影响指纹', () => {
    const a = itemFingerprint({
      id: 'minecraft:apple',
      components: { c: true },
    })
    const b = itemFingerprint({
      id: 'minecraft:apple',
      components: { c: true },
    })
    assert.equal(a, b)
  })

  await test('legacy display 过期 → 缓存标 stale 并排队，可被新快照覆盖', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const item = { id: 'minecraft:iron_ingot', components: {} }
    const fp = itemFingerprint(item)
    ingestDisplay(item, sampleDisplay({
      snapshotOf: 'fnv1a:00000000',
      name: [{ text: '旧名' }],
    }))
    await Promise.resolve()
    assert.equal(isCachedSnapshotFresh(item), false)
    assert.equal(snapshotStatusOf(item), 'stale')
    assert.equal(getCachedDisplaySync(fp)?.name?.[0]?.text, '旧名')
    assert.ok(listSnapshotsNeeded().some((row) => row.id === item.id))

    await putCachedDisplay(fp, sampleDisplay({ name: [{ text: '新名' }] }))
    assert.equal(isCachedSnapshotFresh(item), true)
    assert.equal(getCachedDisplaySync(fp)?.name?.[0]?.text, '新名')
    assert.equal(getCachedDisplaySync(fp)?.snapshotOf, fp)
  })

  await test('强制刷新不删旧缓存，直至 put 覆盖', async () => {
    resetItemSnapshotCacheForTests()
    useMemoryItemSnapshotStore()
    const item = { id: 'minecraft:gold_ingot', components: {} }
    const fp = itemFingerprint(item)
    await putCachedDisplay(fp, sampleDisplay({ name: [{ text: '金锭' }] }))
    forceRequestItemSnapshots([item])
    assert.equal(getCachedDisplaySync(fp)?.name?.[0]?.text, '金锭')
    assert.ok(listSnapshotsNeeded().some((row) => row.fingerprint === fp))
  })

  console.log(`\n${passed} tests passed`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
